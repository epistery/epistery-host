import express from 'express';
import compression from 'compression';
import http from 'http';
import https from 'https';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { Certify } from '@metric-im/administrate';
import { Epistery, Config } from 'epistery';
import { createAuthRouter } from './utils/authentication.mjs';
import { DomainAcl } from './utils/DomainAcl.mjs';
import { DomainChain } from './utils/DomainChain.mjs';
import { OAuthServer } from './utils/OAuthServer.mjs';
import { MCPServer } from './utils/MCPServer.mjs';
import { AIDiscovery } from './utils/AIDiscovery.mjs';
import { AgentManager } from './utils/AgentManager.mjs';
import { PeerBridge } from './utils/PeerBridge.mjs';
import { UserVault } from './utils/UserVault.mjs';
import { retryWithBackoff } from './utils/retryWithBackoff.mjs';
import Pages from './pages/index.mjs'

const require = createRequire(import.meta.url);
const ethers = require('ethers');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load DomainAgent contract artifact from local project
const DomainAgentArtifact = JSON.parse(
    readFileSync(path.join(__dirname, 'artifacts/contracts/DomainAgent.sol/DomainAgent.json'), 'utf8')
);

function estimateDeployGas() {
    const bytecodeLength = DomainAgentArtifact.bytecode.length / 2;
    return 21000 + (bytecodeLength * 200) + 50000;
}

let isShuttingDown = false;
let app, https_server, http_server, config, agentManager, peerBridge;

// Cache HTML templates at startup (avoid readFileSync per request)
const TEMPLATES = {
    claim: readFileSync(path.join(__dirname, 'public', 'claim.html'), 'utf8'),
    initialize: readFileSync(path.join(__dirname, 'public', 'initialize.html'), 'utf8'),
    index: readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8'),
    devtools: readFileSync(path.join(__dirname, 'public', 'devtools.html'), 'utf8'),
};

let main = async function() {
    app = express();
    app.set('trust proxy', 'loopback');  // trust X-Forwarded-Host from 127.0.0.1 (MCP internal proxy)
    app.use(compression());
    app.use((req, res, next) => {
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('X-Frame-Options', 'SAMEORIGIN');
        if (req.secure) {
            res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        }
        next();
    });
    app.use(cors({
        origin: function(origin, callback){
            return callback(null, true);
        },
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization']
    }));
    app.use(express.urlencoded({extended: true}));
    app.use(express.json({limit: '2mb'}));
    app.use(cookieParser());

    // Mount authentication routes
    const authRouter = createAuthRouter();
    app.use(authRouter);

    app.get('/health', (req, res) => {
        res.status(200).send()
    });

    // Build status JSON - shared by both HTML and API responses
    function buildStatus(domain, cfg) {
        const wallet = cfg.data?.wallet || {};
        const provider = cfg.data?.provider || {};
        // Only use finalized contract address for initialized status
        const contractAddress = cfg.data?.contract_address || process.env.CONTRACT_ADDRESS;
        const pendingContractAddress = cfg.data?.agent_contract_pending;
        const isInitialized = contractAddress && contractAddress !== '0x0000000000000000000000000000000000000000';

        return {
            server: {
                walletAddress: wallet.address || null,
                publicKey: wallet.publicKey || null,
                contractAddress: contractAddress || pendingContractAddress || null,
                contractPending: !!pendingContractAddress,
                initialized: isInitialized,
                adminAddress: cfg.data?.admin_address || null,
                provider: provider.name || 'Polygon Mainnet',
                chainId: provider.chainId?.toString() || '137',
                rpc: provider.publicRpc || 'https://polygon-rpc.com',
                nativeCurrency: {
                    symbol: provider.nativeCurrency?.symbol || 'POL',
                    name: provider.nativeCurrency?.name || 'POL',
                    decimals: provider.nativeCurrency?.decimals || 18
                }
            },
            client: {},
            ipfs: {
                url: cfg.data.ipfs?.url,
                gateway: cfg.data.ipfs?.gateway
            },
            timestamp: new Date().toISOString()
        };
    }

    // Main status page - returns HTML or JSON based on Accept header
    app.get('/', async (req, res) => {
        try {
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            // Check if client wants JSON (API request)
            const acceptsJson = req.accepts('json') && !req.accepts('html');

            if (acceptsJson) {
                // Return JSON status
                const status = buildStatus(domain, cfg);
                return res.json(status);
            }

            // Return HTML for browsers
            // Check if domain is claimed/verified
            if (!cfg.data || !cfg.data.verified) {
                // Domain not claimed - show claim page
                const html = TEMPLATES.claim.replace(/{DOMAIN}/g, domain);
                return res.send(html);
            }

            // Check if contract is deployed (unless bypassed with ?home query param)
            const contractAddress = cfg.data?.contract_address;
            const isInitialized = contractAddress && contractAddress !== '0x0000000000000000000000000000000000000000';

            if (!isInitialized && !('home' in req.query)) {
                // Domain verified but no contract - show initialize page
                return res.send(TEMPLATES.initialize);
            }

            // Check if there's a default agent set (and not bypassed with ?home query param)
            const defaultAgent = cfg.data?.default_agent;
            if (defaultAgent && !('home' in req.query) && agentManager) {
                // Find the agent and use its shortPath
                for (const [, agentData] of agentManager.agents) {
                    if (agentData.manifest.name === defaultAgent) {
                        return res.redirect(agentData.shortPath);
                    }
                }
            }

            // Domain is claimed - show regular status page
            const wallet = cfg.data.wallet || {};
            const walletAddress = wallet.address || 'Not configured';

            const html = TEMPLATES.index
                .replace(/{DOMAIN}/g, domain)
                .replace(/{SERVER_WALLET}/g, walletAddress);

            res.send(html);
        } catch (error) {
            console.error('Error serving index:', error);
            res.status(500).send('Error loading page');
        }
    });

    // Dev tools page route (old diagnostic view)
    app.get('/devtools', (req, res) => {
        const domain = req.hostname || 'localhost';
        const cfg = new Config();
        cfg.setPath(domain);
        const wallet = cfg.data?.wallet || {};
        res.send(TEMPLATES.devtools.replace(/{DOMAIN}/g, domain).replace(/{SERVER_WALLET}/g, wallet.address || 'Not configured'));
    });

    // Initialize page route
    app.get('/initialize', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'initialize.html'));
    });

    // Admin page route
    app.get('/admin', (req, res) => {
        const acceptsJson = req.accepts('json') && !req.accepts('html');

        if (acceptsJson) {
            // Return JSON status
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const status = buildStatus(domain, cfg);
            return res.json(status);
        }
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });

    // API: Deploy Agent contract
    // Shared contract deployment logic
    async function deployAgentContract(req, res) {
        try {
            const domain = req.hostname || req.body.domain || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const serverWallet = cfg.data?.wallet;
            const provider = cfg.data?.provider;
            const adminAddress = cfg.data?.admin_address;

            if (!serverWallet || !serverWallet.mnemonic) {
                return res.status(500).json({ error: 'Server wallet not configured' });
            }

            if (!provider || !provider.rpc) {
                return res.status(500).json({ error: 'Provider not configured' });
            }

            if (!adminAddress) {
                return res.status(500).json({ error: 'Admin address not configured - cannot complete initialization' });
            }

            const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc, {
                chainId: parseInt(provider.chainId),
                name: provider.name
            });
            const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

            // Check balance upfront for deployment + initialization
            const balance = await retryWithBackoff(() => ethersProvider.getBalance(wallet.address));
            const feeData = await retryWithBackoff(() => ethersProvider.getFeeData());
            // Use network gasPrice as floor — some chains (JOC) have near-zero baseFee
            // but high minimum gas price, so EIP-1559 computed values are too low
            const minGasPrice = feeData.gasPrice || ethers.utils.parseUnits("30", "gwei");

            // Estimate based on actual bytecode size (more accurate than fixed 750k)
            const estimatedDeploymentGas = ethers.BigNumber.from(estimateDeployGas());
            // Add 20% buffer to gas estimate
            const deploymentGas = estimatedDeploymentGas.mul(120).div(100);
            const initGas = ethers.BigNumber.from(300000);
            const totalGas = deploymentGas.add(initGas);

            const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
            const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);
            const estimatedTotalCost = totalGas.mul(maxFeePerGas);
            const requiredBalance = estimatedTotalCost.mul(150).div(100); // 50% buffer

            if (balance.lt(requiredBalance)) {
                return res.status(400).json({
                    error: 'Insufficient balance for deployment and initialization',
                    balance: ethers.utils.formatEther(balance),
                    required: ethers.utils.formatEther(requiredBalance),
                    currency: provider.nativeCurrency?.symbol || 'POL',
                    serverWallet: wallet.address
                });
            }

            // Use EIP-1559 style transaction
            const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
            const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;

            const factory = new ethers.ContractFactory(DomainAgentArtifact.abi, DomainAgentArtifact.bytecode, wallet);
            // Server wallet is host (manages the contract)
            // Browser wallet (admin_address) is owner (paid for and owns the contract)
            const ownerAddress = adminAddress || wallet.address; // Owner defaults to server if no admin

            // Deploy with domain, owner, and host parameters, plus EIP-1559 gas settings
            // Try to estimate gas, fallback to calculated limit if estimation fails
            let gasLimit;
            try {
                const deployTx = factory.getDeployTransaction(domain, ownerAddress, wallet.address);
                gasLimit = await ethersProvider.estimateGas({ ...deployTx, from: wallet.address });
                gasLimit = gasLimit.mul(120).div(100); // Add 20% buffer
            } catch (estimateError) {
                // Estimation failed - calculate based on bytecode size
                gasLimit = ethers.BigNumber.from(estimateDeployGas());
            }

            const contract = await factory.deploy(domain, ownerAddress, wallet.address, {
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas,
                gasLimit: gasLimit
            });
            await retryWithBackoff(() => contract.deployed());

            const contractAddress = contract.address;

            // Check contract version
            let version = 'Unknown';
            try {
                version = await retryWithBackoff(() => contract.VERSION());
            } catch (e) {
                version = '1.0.0';
            }

            // Save old contract address before overwriting
            const oldContractAddress = cfg.data?.contract_address;

            // Finalize: promote to active contract
            cfg.data.contract_address = contractAddress;
            delete cfg.data.agent_contract_pending;
            cfg.data.contract_deployed_at = new Date().toISOString();
            cfg.data.contract_version = version;
            cfg.data.acl_initialized_at = new Date().toISOString();
            if (oldContractAddress) {
                cfg.data.previous_contract_address = oldContractAddress;
            }
            cfg.save();

            const txOverrides = { maxPriorityFeePerGas, maxFeePerGas };

            if (oldContractAddress && oldContractAddress !== contractAddress) {
                const chain = new DomainChain(domain);
                await chain.migrateContract(oldContractAddress, contract, ownerAddress, txOverrides);
            } else {
                // Fresh deploy — initialize default agent ACL configs
                try {
                    const messageBoardConfig = {
                        aclStance: {
                            acl: [
                                { list: 'epistery::admin', access: 3 },
                                { list: 'epistery::editor', access: 2 },
                                { list: 'default', access: 0 }
                            ],
                            enableRequestAccess: true
                        }
                    };
                    const tx = await contract.setPublicAttribute(
                        '@epistery/message-board',
                        JSON.stringify(messageBoardConfig),
                        txOverrides
                    );
                    await tx.wait();
                } catch (aclError) {
                    console.error('Failed to initialize agent ACL configs:', aclError);
                }

            }

            // Store in environment for current session
            process.env.CONTRACT_ADDRESS = contractAddress;

            res.json({
                success: true,
                address: contractAddress,
                contractAddress: contractAddress,
                version: version,
                domain: domain,
                initialized: true,
                message: 'Agent contract deployed and initialized successfully'
            });
        } catch (error) {
            console.error('Error deploying contract:', error);
            console.error('Error details:', {
                message: error.message,
                code: error.code,
                reason: error.reason,
                transaction: error.transaction,
                receipt: error.receipt
            });

            // Provide more informative error messages
            let userMessage = error.message;
            let errorDetails = `Code: ${error.code}, Reason: ${error.reason}`;

            if (error.code === 'INSUFFICIENT_FUNDS') {
                userMessage = 'Insufficient funds in server wallet to deploy contract';
            } else if (error.code === 'NETWORK_ERROR' || error.message.includes('timeout')) {
                userMessage = `Network error - RPC endpoint may be rate limiting or unavailable. ${errorDetails}. Please try again in a few moments.`;
            } else if (error.code === 'UNPREDICTABLE_GAS_LIMIT') {
                userMessage = 'Unable to estimate gas - transaction may fail. Network may be congested.';
            } else if (error.message.includes('nonce')) {
                userMessage = 'Transaction nonce error - please try again';
            } else if (error.message.includes('gas')) {
                userMessage = 'Gas estimation failed - network may be congested or rate limiting';
            }

            res.status(500).json({
                error: userMessage,
                technicalDetails: error.message,
                code: error.code
            });
        }
    }

    // API: Check if server wallet has sufficient balance for deployment
    app.post('/api/check-deploy-balance', async (req, res) => {
        try {
            const domain = req.hostname || req.body.domain || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const provider = cfg.data?.provider;
            if (!provider || !provider.rpc) {
                return res.status(500).json({ error: 'Provider not configured' });
            }

            const serverWallet = cfg.data?.wallet;
            if (!serverWallet || !serverWallet.mnemonic) {
                return res.status(500).json({ error: 'Server wallet not configured' });
            }

            const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc, {
                chainId: parseInt(provider.chainId),
                name: provider.name
            });
            const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

            // Get current balance
            const balance = await ethersProvider.getBalance(wallet.address);

            // Estimate deployment cost using same logic as actual deployment
            const feeData = await ethersProvider.getFeeData();
            const minGasPrice = feeData.gasPrice || ethers.utils.parseUnits("30", "gwei");

            // Estimate based on actual bytecode size (same as deployment)
            const estimatedDeploymentGas = ethers.BigNumber.from(estimateDeployGas());
            // Add 20% buffer to gas estimate
            const deploymentGas = estimatedDeploymentGas.mul(120).div(100);
            const initGas = ethers.BigNumber.from(300000);
            const totalGas = deploymentGas.add(initGas);

            const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
            const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);
            const estimatedCost = totalGas.mul(maxFeePerGas);

            // Add 50% buffer
            const required = estimatedCost.mul(150).div(100);
            const sufficient = balance.gte(required);

            res.json({
                address: wallet.address,
                balance: ethers.utils.formatEther(balance),
                currencySymbol: provider.nativeCurrencySymbol || 'POL',
                estimatedCost: ethers.utils.formatEther(estimatedCost),
                required: ethers.utils.formatEther(required),
                sufficient: sufficient,
                gasEstimate: totalGas.toString(),
                maxFeePerGas: ethers.utils.formatUnits(maxFeePerGas, 'gwei')
            });
        } catch (error) {
            console.error('Balance check error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/contract/deploy', deployAgentContract);

    // API: Check DomainAgent contract version
    app.get('/api/domain-agent/version', async (req, res) => {
        try {
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            // Read expected version from DomainAgent.sol source file (source of truth)
            let DOMAIN_AGENT_VERSION = '1.0.0'; // fallback
            try {
                const contractSource = readFileSync(path.join(__dirname, 'contracts/DomainAgent.sol'), 'utf8');
                const versionMatch = contractSource.match(/VERSION\s*=\s*"([^"]+)"/);
                if (versionMatch) {
                    DOMAIN_AGENT_VERSION = versionMatch[1];
                }
            } catch (e) {
                console.error('[api/domain-agent/version] Error reading contract version:', e.message);
            }

            const contractAddress = cfg.data?.contract_address;

            // If no contract deployed, indicate upgrade needed
            if (!contractAddress) {
                return res.json({
                    needsUpgrade: true,
                    reason: 'no_contract',
                    deployedVersion: null,
                    expectedVersion: DOMAIN_AGENT_VERSION,
                    contractAddress: null
                });
            }

            // Query the on-chain VERSION() constant — the config can be stale
            let deployedVersion = null;
            try {
                const chain = new DomainChain(domain);
                if (chain.contract) {
                    deployedVersion = await chain.contract.VERSION();
                }
            } catch (e) {
                console.warn('[api/domain-agent/version] Could not read on-chain VERSION:', e.message);
            }

            // Check if version matches DomainAgent.sol
            const needsUpgrade = !deployedVersion || deployedVersion !== DOMAIN_AGENT_VERSION;

            res.json({
                needsUpgrade,
                reason: needsUpgrade ? 'version_mismatch' : 'up_to_date',
                deployedVersion,
                expectedVersion: DOMAIN_AGENT_VERSION,
                contractAddress
            });
        } catch (error) {
            console.error('[api/domain-agent/version] Error:', error);
            res.status(500).json({
                needsUpgrade: true,
                reason: 'check_failed',
                error: error.message
            });
        }
    });

    // API: Provider defaults from root config (for claim page)
    // Returns chain info with a public RPC URL (never the private/paid one)
    const PUBLIC_RPC = {
        '137': 'https://polygon-rpc.com',
        '1': 'https://eth.llamarpc.com',
        '81': 'https://rpc-2.japanopenchain.org:8545',
        '80002': 'https://rpc-amoy.polygon.technology',
        '11155111': 'https://eth-sepolia.public.blastapi.io'
    };
    app.get('/api/provider-defaults', (req, res) => {
        const rootCfg = new Config();
        const rootData = rootCfg.read('/');
        const defaults = rootData?.default?.provider || {};
        const chainId = String(defaults.chainId || '137');
        res.json({
            name: defaults.name || 'Polygon Mainnet',
            chainId: chainId,
            rpc: defaults.publicRpc || PUBLIC_RPC[chainId] || 'https://polygon-rpc.com',
            nativeCurrencyName: defaults.nativeCurrencyName || 'POL',
            nativeCurrencySymbol: defaults.nativeCurrencySymbol || 'POL',
            nativeCurrencyDecimals: defaults.nativeCurrencyDecimals || '18'
        });
    });

    // Static files (after specific routes)
    const staticOpts = { maxAge: '1d', etag: true };
    app.use('/style', express.static(path.join(__dirname, 'public/style'), staticOpts));
    app.use('/image', express.static(path.join(__dirname, 'public/image'), staticOpts));
    app.use('/script', express.static(path.join(__dirname, 'public/script'), staticOpts));
    app.use('/widgets', express.static(path.join(__dirname, 'public/widgets'), staticOpts));
    // /.well-known/ai is now served dynamically by AIDiscovery (mounted after MCPServer)

    // Serve service worker (must be at root for scope)
    app.get('/service-worker.js', (req, res) => {
        res.sendFile(path.join(__dirname, 'public/service-worker.js'));
    });

    // Serve qrcode library
    app.get('/lib/qrcode.js', (req, res) => {
        res.sendFile(path.join(__dirname, 'node_modules/qrcode-generator/dist/qrcode.js'));
    });
    // Serve zebratime library
    app.get('/lib/zebratime.js', (req, res) => {
        res.sendFile(path.join(__dirname, 'node_modules/zebratime/zebratime.js'));
    });

    // Attach epistery at root
    const epistery = await Epistery.connect();
    await epistery.attach(app,'/');
    app.locals.epistery = epistery;

    // Mount ACL routes AFTER epistery (req.episteryClient will be available)
    DomainAcl.attach(app)

    // Mount UserVault (encrypted per-user storage, like server-side cookies)
    UserVault.attach(app);

    // Mount OAuth 2.1 server (Bearer middleware + well-known + endpoints)
    OAuthServer.attach(app);

    // Mount MCP server (JSON-RPC over Streamable HTTP at /mcp)
    MCPServer.attach(app);

    // Mount dynamic AI Discovery endpoint (/.well-known/ai)
    AIDiscovery.attach(app);

    // Also mount the same routes at RFC 8615 well-known path
    // Note: We reuse the routes() to avoid duplicate middleware
    app.use('/.well-known/epistery', epistery.routes());

    // Attach template pages/frames
    const pages = new Pages({ DomainAgentArtifact });
    pages.attach(app);

    // API endpoint to list active agents
    app.get('/api/agents', async (req, res) => {
        if (!agentManager) {
            return res.json({ agents: [] });
        }

        const domain = req.headers.host?.split(':')[0] || 'localhost';
        const cfg = new Config();
        cfg.setPath(domain);

        const defaultAgent = cfg.data?.default_agent || null;
        const enabledAgents = cfg.data?.enabled_agents || {};

        const agents = [];
        for (const [, agentData] of agentManager.agents) {
            // Default to enabled if not specified
            const enabled = enabledAgents[agentData.manifest.name] !== false;

            agents.push({
                name: agentData.manifest.name,
                simpleName: agentData.manifest.name.split('/').pop(),
                title: agentData.manifest.title,
                version: agentData.manifest.version,
                description: agentData.manifest.description,
                icon: agentData.manifest.icon || null,
                homepage: agentData.manifest.homepage || null,
                widget: agentData.manifest.widget || null,
                noUserInterface: agentData.manifest.noUserInterface || false,
                wellKnownPath: agentData.wellKnownPath,
                shortPath: agentData.shortPath,
                enabled: enabled
            });
        }

        res.json({ agents, defaultAgent });
    });

    // API endpoint to get navigation menu HTML
    app.get('/api/nav-menu', async (req, res) => {
        if (!agentManager) {
            return res.send('<ul class="nav-menu"><li><a href="/?home">Home</a></li></ul>');
        }
        const domain = req.headers.host?.split(':')[0] || 'localhost';
        const cfg = new Config();
        cfg.setPath(domain);
        const defaultAgent = cfg.data?.default_agent || null;
        const verified = cfg.data?.verified || false;

        // Check if authenticated user is admin
        let isAdmin = false;
        if (req.episteryClient) {
            isAdmin = await req.domainAcl.isAdmin(req.episteryClient.address);
        }

        let navBar = "";
        for (const [, agentData] of agentManager.agents) {
            if (agentData.manifest.noUserInterface) continue;
            const displayName = agentData.manifest.title || agentData.manifest.name.split('/').pop();
            navBar += `<a href="${agentData.shortPath}">${agentData.manifest.icon ? `<img alt="${displayName}" src="${agentData.manifest.icon}">` : ''} <span>${displayName}</span></a>`;
        }

        // Only show admin link if user is on epistery::admin list
        if (isAdmin) {
            navBar += '<a href="/admin"><img alt="Administrate" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 24 24\' fill=\'%232d5016\'%3E%3Cpath d=\'M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.31-.61-.22l-2.49 1c-.52-.39-1.06-.73-1.69-.98l-.37-2.65A.506.506 0 0 0 14 2h-4c-.25 0-.46.18-.5.42l-.37 2.65c-.63.25-1.17.59-1.69.98l-2.49-1c-.22-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64L4.57 11c-.04.34-.07.67-.07 1 0 .33.03.65.07.97l-2.11 1.66c-.19.15-.25.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1.01c.52.4 1.06.74 1.69.99l.37 2.65c.04.24.25.42.5.42h4c.25 0 .46-.18.5-.42l.37-2.65c.63-.26 1.17-.59 1.69-.99l2.49 1.01c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64z\'/%3E%3C/svg%3E"> <span>Administrate</span></a>';
        }

        res.send(navBar);
    });

    // API endpoint to set default agent (requires admin auth)
    app.post('/api/set-default-agent', async (req, res) => {
        try {
            const { agentName } = req.body;
            const domain = req.headers.host?.split(':')[0] || 'localhost';

            if (agentName === undefined) {
                return res.status(400).json({ error: 'agentName is required' });
            }

            // Check if user is admin
            const isAdmin = await req.domainAcl.isAdmin(req.episteryClient?.address);
            if (!isAdmin) {
                return res.status(403).json({ error: 'Not authorized' });
            }

            // If agentName is empty string, clear the default
            if (agentName === '') {
                const cfg = new Config();
                cfg.setPath(domain);
                delete cfg.data.default_agent;
                cfg.save();
                return res.json({ success: true });
            }

            // Verify agent exists
            if (!agentManager) {
                return res.status(500).json({ error: 'Agent manager not initialized' });
            }

            let agentExists = false;
            for (const [, agentData] of agentManager.agents) {
                if (agentData.manifest.name === agentName) {
                    agentExists = true;
                    break;
                }
            }

            if (!agentExists) {
                return res.status(404).json({ error: 'Agent not found' });
            }

            // Save to config
            const cfg = new Config();
            cfg.setPath(domain);
            cfg.data.default_agent = agentName;
            cfg.save();

            res.json({ success: true });
        } catch (error) {
            console.error('[set-default-agent] Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API endpoint to toggle agent enabled status (requires admin auth)
    app.post('/api/toggle-agent', async (req, res) => {
        try {
            const { agentName, enabled } = req.body;
            const domain = req.headers.host?.split(':')[0] || 'localhost';

            if (!agentName || enabled === undefined) {
                return res.status(400).json({ error: 'agentName and enabled are required' });
            }

            // Check if user is admin
            const isAdmin = await req.domainAcl.isAdmin(req.episteryClient?.address);
            if (!isAdmin) {
                return res.status(403).json({ error: 'Not authorized' });
            }

            // Save to config
            const cfg = new Config();
            cfg.setPath(domain);

            if (!cfg.data.enabled_agents) {
                cfg.data.enabled_agents = {};
            }

            cfg.data.enabled_agents[agentName] = enabled;
            cfg.save();

            res.json({ success: true });
        } catch (error) {
            console.error('[toggle-agent] Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Get storage status (admin only)
    app.get('/api/storj-status', async (req, res) => {
        try {
            const isAdmin = await req.domainAcl?.isAdmin(req.episteryClient?.address);
            if (!isAdmin) return res.status(403).json({ error: 'Not authorized' });

            const domain = req.headers.host?.split(':')[0] || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const rootCfg = new Config();
            const rootData = rootCfg.read('/');

            // Check for S3 credentials (domain-level or root-level)
            const domainStorj = cfg.data.storj;
            const rootStorj = rootData?.storj;
            const storjConfig = domainStorj || rootStorj;
            const hasStorage = !!(storjConfig?.ACCESS_KEY);

            // Encryption: on by default, off only if explicitly disabled
            const encryptionEnabled = cfg.data.storage_encrypted !== 'false';

            // Check if domain has a master key initialized
            let hasMasterKey = false;
            try {
                const raw = cfg.readFile('master-key.json');
                hasMasterKey = !!JSON.parse(raw);
            } catch {}

            res.json({
                hasStorage,
                backend: hasStorage ? 'S3' : 'Config',
                endpoint: storjConfig?.ENDPOINT || null,
                bucket: storjConfig?.BUCKET || null,
                region: storjConfig?.REGION || null,
                encrypted: encryptionEnabled && hasMasterKey,
                encryptionEnabled,
                customCredentials: !!domainStorj
            });
        } catch (error) {
            console.error('[storage-status] Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Update storage configuration (admin only)
    app.post('/api/storage-config', async (req, res) => {
        try {
            const isAdmin = await req.domainAcl?.isAdmin(req.episteryClient?.address);
            if (!isAdmin) return res.status(403).json({ error: 'Not authorized' });

            const domain = req.headers.host?.split(':')[0] || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const { action, storj, encrypted } = req.body;

            if (action === 'set-credentials') {
                if (!storj?.ACCESS_KEY || !storj?.SECRET_KEY || !storj?.BUCKET) {
                    return res.status(400).json({ error: 'ACCESS_KEY, SECRET_KEY, and BUCKET are required' });
                }
                cfg.data.storj = {
                    ACCESS_KEY: storj.ACCESS_KEY,
                    SECRET_KEY: storj.SECRET_KEY,
                    ENDPOINT: storj.ENDPOINT || '',
                    BUCKET: storj.BUCKET,
                    REGION: storj.REGION || ''
                };
                cfg.save();
                console.log(`[storage-config] Updated S3 credentials for ${domain}`);
                return res.json({ success: true, message: 'Storage credentials updated. Restart agents to apply.' });
            }

            if (action === 'clear-credentials') {
                delete cfg.data.storj;
                cfg.save();
                console.log(`[storage-config] Cleared custom S3 credentials for ${domain}`);
                return res.json({ success: true, message: 'Custom credentials removed. Using host defaults.' });
            }

            if (action === 'set-encryption') {
                cfg.data.storage_encrypted = encrypted ? 'true' : 'false';
                cfg.save();
                console.log(`[storage-config] Encryption ${encrypted ? 'enabled' : 'disabled'} for ${domain}`);
                return res.json({ success: true, message: `Encryption ${encrypted ? 'enabled' : 'disabled'}. New writes will use this setting.` });
            }

            res.status(400).json({ error: 'Unknown action' });
        } catch (error) {
            console.error('[storage-config] Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Get user preferences
    app.get('/api/preferences', async (req, res) => {
        try {
            const userAddress = req.episteryClient?.address;
            if (!userAddress) {
                return res.status(401).json({ error: 'Not authenticated' });
            }

            const domain = req.headers.host?.split(':')[0] || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            // Get preferences for this user
            const prefsKey = `user_preferences.${userAddress}`;
            const prefs = cfg.data[prefsKey] || { notifications: false };

            res.json(prefs);
        } catch (error) {
            console.error('[preferences] Get error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Save user preferences
    app.post('/api/preferences', async (req, res) => {
        try {
            const userAddress = req.episteryClient?.address;
            if (!userAddress) {
                return res.status(401).json({ error: 'Not authenticated' });
            }

            const domain = req.headers.host?.split(':')[0] || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            // Save preferences for this user
            const prefsKey = `user_preferences.${userAddress}`;
            cfg.data[prefsKey] = {
                ...cfg.data[prefsKey],
                ...req.body,
                updated_at: new Date().toISOString()
            };
            cfg.save();

            res.json({ success: true, preferences: cfg.data[prefsKey] });
        } catch (error) {
            console.error('[preferences] Save error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    config = new Config();
    const http_port = parseInt(process.env.PORT || 4080);
    const https_port = parseInt(process.env.PORTSSL || 4443);
    const certify = await Certify.attach(app);

    // Load and attach agent modules from ~/.epistery/.agents
    const agentsPath = path.join(config.configDir, '.agents');
    agentManager = new AgentManager(agentsPath);
    await agentManager.loadAll(app);
    app.locals.agentManager = agentManager;

    https_server = https.createServer({...certify.SNI},app);
    https_server.listen(https_port);
    https_server.on('error', console.error);
    https_server.on('listening',()=>{
        let address = https_server.address();
        console.log(`Listening on ${address.address} ${address.port} (${address.family})`);
    });
    http_server = http.createServer(app);

    http_server.listen(http_port);
    http_server.on('error', console.error);
    http_server.on('listening',()=>{
        let address = http_server.address();
        console.log(`Listening on ${address.address} ${address.port} (${address.family})`);
    });

    // Initialize WebSocket servers for agents that support it
    agentManager.initializeWebSockets(https_server);
    agentManager.initializeWebSockets(http_server);

    // Initialize PeerBridge for host-to-host tool bridging
    peerBridge = new PeerBridge(agentManager, {
        port: http_port,
        getStore: async (domain) => {
            const signer = app.locals.epistery?.signer;
            if (!signer) return null;
            const { OAuthServer } = await import('./utils/OAuthServer.mjs');
            return OAuthServer.getStore(domain, signer);
        },
        getSigner: () => app.locals.epistery?.signer
    });
    peerBridge.initWebSocketServer(https_server);
    peerBridge.initWebSocketServer(http_server);
    agentManager.peerBridge = peerBridge;
    app.locals.peerBridge = peerBridge;

    // Connect to configured bridge peers (non-blocking)
    const defaultDomain = process.env.DOMAIN || 'localhost';
    peerBridge.connectToConfiguredPeers(defaultDomain).catch(err => {
        console.error('[bridge] Failed to connect to peers:', err.message);
    });
}();

const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`Received ${signal}, shutting down gracefully...`);

    try {
        // Set a timeout to force exit if graceful shutdown takes too long
        const forceExitTimer = setTimeout(() => {
            console.log('Forced shutdown after timeout');
            process.exit(1);
        }, 5000); // 5 second timeout

        // Stop accepting new connections
        const closeServer = (server, name) => {
            return Promise.race([
                new Promise(resolve => {
                    if (server) {
                        server.close(() => {
                            console.log(`${name} server closed`);
                            resolve();
                        });
                        // Force close all connections
                        server.closeAllConnections?.();
                    } else {
                        resolve();
                    }
                }),
                new Promise(resolve => setTimeout(() => {
                    console.log(`${name} server close timed out, forcing...`);
                    resolve();
                }, 3000))
            ]);
        };

        await closeServer(https_server, 'HTTPS');
        await closeServer(http_server, 'HTTP');

        // Cleanup peer bridge
        if (peerBridge) {
            peerBridge.cleanup();
            console.log('Peer bridge cleaned up');
        }

        // Cleanup agent modules
        if (agentManager) {
            await agentManager.cleanup();
            console.log('Agent modules cleaned up');
        }

        clearTimeout(forceExitTimer);
        console.log('Graceful shutdown complete');
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
//eyJqa3UiOiJodHRwczovL2xvY2FsaG9zdDo4MDgwL3VhYS90b2tlbl9rZXlzIiwia2lkIjoia2V5LWlkLTEiLCJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmN2ZiMWVjYy0yODg1LTRiMDMtYTIwYS1mMTFiOWJiMzg0YTQiLCJ1c2VyX25hbWUiOiIwZjlmNTBmNi02YzZiLTQ5YWEtYmRhYy0wNTVhZjUyNTM0MGIiLCJvcmlnaW4iOiJ1YWEiLCJpc3MiOiJodHRwOi8vbG9jYWxob3N0OjgwODAvdWFhL29hdXRoL3Rva2VuIiwiY2xpZW50X2lkIjoiYWNtZV93ZWIiLCJhdWQiOlsicWNzIiwidWFhIiwib3BlbmlkIiwiYWNtZV93ZWIiXSwiemlkIjoidWFhIiwiZ3JhbnRfdHlwZSI6ImF1dGhvcml6YXRpb25fY29kZSIsInVzZXJfaWQiOiJmN2ZiMWVjYy0yODg1LTRiMDMtYTIwYS1mMTFiOWJiMzg0YTQiLCJhdXRoX3RpbWUiOjE3NzE3MDkxODIsImdyYW50ZWRfc2NvcGVzIjpbIm9wZW5pZCIsInFjcy5tZSIsInVhYS51c2VyIl0sImV4cCI6MTg2NjMxNzE4MiwiaWF0IjoxNzcxNzA5MTgyLCJqdGkiOiI2YjJjMGMyOTk1MGY0ZjYzYWFjNTUwMTgxYWExZGQyNC1yIiwicmV2X3NpZyI6ImU1YWVjODEwIiwiY2lkIjoiYWNtZV93ZWIifQ.t0NRzxYbXB3gN-Y53ImRNNzKMpisJA7kDbOPso0m4NhFA1GsCWVJUbM0-e1I4BmpLCh3032GYmPFQDXZv1j6tLAVrw8eBYP8geyjx_TTyPCa-BfFHZejJuaE2NwAHPl5cmR7OPMaWRs5ua1jty56MZsEPJE8S1lCNzUMMPGykAwHm-jVwH0Mu2Gl8tdbe9ZV83fK2MqudJknKaXNwjkyagL7g5AFyGHn55xj7n4Jq2945oAM78rt4xnjFwSrpoeEIDv599mtb3ciK6PSWlhYTX0zkwaH4UEpWoEWqUTU7ZDEsA7_ecWOVzjoyd7oOg1irjzIhKTsg9N0eEy50fydpg