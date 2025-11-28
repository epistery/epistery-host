import express from 'express';
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
import { createAuthRouter } from './authentication.mjs';
import { AgentManager } from './AgentManager.mjs';

const require = createRequire(import.meta.url);
const ethers = require('ethers');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Agent contract artifact - resolve through the symlinked epistery package
const AgentArtifact = JSON.parse(
    readFileSync(path.join(__dirname, 'node_modules/epistery/artifacts/contracts/agent.sol/Agent.json'), 'utf8')
);

let isShuttingDown = false;
let app, https_server, http_server, config, agentManager;

let main = async function() {
    app = express();
    app.use(cors({
        origin: function(origin, callback){
            return callback(null, true);
        },
        credentials:true
    }));
    app.use(express.urlencoded({extended: true}));
    app.use(express.json({limit: '50mb'}));
    app.use(cookieParser());

    // Mount authentication routes
    const authRouter = createAuthRouter();
    app.use(authRouter);

    app.get('/health', (req, res) => {
        res.status(200).send()
    });


    // API endpoint to list active agents
    app.get('/api/agents', (req, res) => {
        if (!agentManager) {
            return res.json({ agents: [] });
        }

        const agents = [];
        for (const [, agentData] of agentManager.agents) {
            agents.push({
                name: agentData.manifest.name,
                version: agentData.manifest.version,
                description: agentData.manifest.description,
                icon: agentData.manifest.icon || null,
                widget: agentData.manifest.widget || null,
                wellKnownPath: agentData.wellKnownPath,
                shortPath: agentData.shortPath
            });
        }

        res.json({ agents });
    });

    // Build status JSON - shared by both HTML and API responses
    function buildStatus(domain, cfg) {
        const wallet = cfg.data?.wallet || {};
        const provider = cfg.data?.provider || {};
        // Check both persisted config and environment variable
        const contractAddress = cfg.data?.agent_contract_address || process.env.AGENT_CONTRACT_ADDRESS;
        const isInitialized = contractAddress && contractAddress !== '0x0000000000000000000000000000000000000000';

        return {
            server: {
                walletAddress: wallet.address || null,
                publicKey: wallet.publicKey || null,
                contractAddress: isInitialized ? contractAddress : null,
                initialized: isInitialized,
                adminAddress: cfg.data?.admin_address || null,
                provider: provider.name || 'Polygon Mainnet',
                chainId: provider.chainId?.toString() || '137',
                rpc: provider.rpc || 'https://polygon-rpc.com',
                nativeCurrency: {
                    symbol: provider.nativeCurrency?.symbol || 'POL',
                    name: provider.nativeCurrency?.name || 'POL',
                    decimals: provider.nativeCurrency?.decimals || 18
                }
            },
            client: {},
            ipfs: {
                url: process.env.IPFS_URL || 'https://rootz.digital/api/v0'
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
                const claimTemplate = readFileSync(path.join(__dirname, 'public', 'claim.html'), 'utf8');
                const html = claimTemplate.replace(/{DOMAIN}/g, domain);
                return res.send(html);
            }

            // Domain is claimed - show regular status page
            const wallet = cfg.data.wallet || {};
            const walletAddress = wallet.address || 'Not configured';

            const template = readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
            const html = template
                .replace(/{DOMAIN}/g, domain)
                .replace(/{SERVER_WALLET}/g, walletAddress);

            res.send(html);
        } catch (error) {
            console.error('Error serving index:', error);
            res.status(500).send('Error loading page');
        }
    });

    // Initialize page route
    app.get('/initialize', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'initialize.html'));
    });

    // Admin page route
    app.get('/admin', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });

    // API: Deploy Agent contract
    app.post('/api/deploy-agent', async (req, res) => {
        try {
            const domain = req.hostname || req.body.domain || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const serverWallet = cfg.data?.wallet;
            const provider = cfg.data?.provider;

            if (!serverWallet || !serverWallet.mnemonic) {
                return res.status(500).json({ error: 'Server wallet not configured' });
            }

            if (!provider || !provider.rpc) {
                return res.status(500).json({ error: 'Provider not configured' });
            }

            const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
            const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

            // Get current gas price from network and add buffer
            const feeData = await ethersProvider.getFeeData();

            // Polygon Amoy requires minimum 25 Gwei, use 30 Gwei to be safe
            const minGasPrice = ethers.utils.parseUnits("30", "gwei");

            // Use EIP-1559 style transaction (maxPriorityFeePerGas + maxFeePerGas)
            // Apply 120% buffer to network prices, but enforce minimum
            const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
            const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;

            const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
            const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);

            const factory = new ethers.ContractFactory(AgentArtifact.abi, AgentArtifact.bytecode, wallet);
            console.log(`Deploying Agent contract for domain: ${domain}, sponsor: ${wallet.address}...`);

            // Deploy with domain and sponsor parameters, plus EIP-1559 gas settings
            const contract = await factory.deploy(domain, wallet.address, {
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas
            });
            await contract.deployed();

            const contractAddress = contract.address;
            console.log(`Agent contract deployed at ${contractAddress}`);

            // Store in environment for current session
            process.env.AGENT_CONTRACT_ADDRESS = contractAddress;

            // Persist to domain config
            cfg.data.agent_contract_address = contractAddress;
            cfg.save();
            console.log(`Contract address saved to domain config: ${domain}`);

            res.json({
                success: true,
                contractAddress: contractAddress,
                message: 'Agent contract deployed successfully'
            });
        } catch (error) {
            console.error('Error deploying contract:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Initialize whitelist with admin address
    app.post('/api/initialize-whitelist', async (req, res) => {
        try {
            const { domain: reqDomain, contractAddress } = req.body;
            const domain = req.hostname || reqDomain || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const adminAddress = cfg.data?.admin_address;
            if (!adminAddress) {
                return res.status(400).json({ error: 'Admin address not configured in config.ini' });
            }

            const serverWallet = cfg.data?.wallet;
            const provider = cfg.data?.provider;

            if (!serverWallet || !serverWallet.mnemonic) {
                return res.status(500).json({ error: 'Server wallet not configured' });
            }

            if (!provider || !provider.rpc) {
                return res.status(500).json({ error: 'Provider not configured' });
            }

            const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
            const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

            // Get current gas price from network and add buffer
            const feeData = await ethersProvider.getFeeData();

            // Polygon Amoy requires minimum 25 Gwei, use 30 Gwei to be safe
            const minGasPrice = ethers.utils.parseUnits("30", "gwei");

            // Use EIP-1559 style transaction (maxPriorityFeePerGas + maxFeePerGas)
            // Apply 120% buffer to network prices, but enforce minimum
            const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
            const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;

            const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
            const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);

            const contract = new ethers.Contract(contractAddress, AgentArtifact.abi, wallet);

            console.log(`Adding ${adminAddress} to admin list for domain ${domain}...`);

            // Add with admin role (3) and metadata
            const listName = `domain::${domain}`;
            const role = 3; // admin
            const name = 'Domain Administrator';
            const meta = JSON.stringify({ addedBy: 'initialization', addedAt: new Date().toISOString() });

            const tx = await contract.addToWhitelist(listName, adminAddress, name, role, meta, {
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas
            });
            await tx.wait();

            console.log('Admin address added to list successfully');

            res.json({
                success: true,
                adminAddress: adminAddress,
                domain: domain,
                message: 'Admin address added to whitelist'
            });
        } catch (error) {
            console.error('Error initializing whitelist:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Check if address is admin
    app.post('/api/check-admin', async (req, res) => {
        try {
            const { address } = req.body;
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = cfg.data?.agent_contract_address || process.env.AGENT_CONTRACT_ADDRESS;
            if (!contractAddress) {
                return res.json({ isAdmin: false, reason: 'Contract not deployed' });
            }

            const serverWallet = cfg.data?.wallet;
            const provider = cfg.data?.provider;

            if (!serverWallet || !provider) {
                return res.status(500).json({ error: 'Server not configured' });
            }

            const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
            const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);
            const contract = new ethers.Contract(contractAddress, AgentArtifact.abi, wallet);

            const listName = `domain::${domain}`;
            const isListed = await contract.isWhitelisted(serverWallet.address, listName, address);

            res.json({ isAdmin: isListed });
        } catch (error) {
            console.error('Error checking admin status:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Get whitelist
    app.get('/api/whitelist', async (req, res) => {
        try {
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = cfg.data?.agent_contract_address || process.env.AGENT_CONTRACT_ADDRESS;
            if (!contractAddress) {
                return res.status(400).json({ error: 'Contract not deployed' });
            }

            const serverWallet = cfg.data?.wallet;
            const provider = cfg.data?.provider;

            if (!serverWallet || !provider) {
                return res.status(500).json({ error: 'Server not configured' });
            }

            const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
            const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);
            const contract = new ethers.Contract(contractAddress, AgentArtifact.abi, wallet);

            // Get list from contract (returns WhitelistEntry[] with addr, name, role, meta)
            const listName = `domain::${domain}`;
            const whitelistEntries = await contract.getWhitelist(serverWallet.address, listName);

            // Transform to simple format for API response
            const whitelist = whitelistEntries.map(entry => entry.addr);
            const metadata = {};
            whitelistEntries.forEach(entry => {
                metadata[entry.addr.toLowerCase()] = {
                    name: entry.name,
                    isAdmin: entry.role >= 3  // role 3=admin, 4=owner
                };
            });

            res.json({
                domain: domain,
                whitelist: whitelist,
                metadata: metadata,
                count: whitelist.length
            });
        } catch (error) {
            console.error('Error getting whitelist:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Add address to whitelist
    app.post('/api/whitelist/add', async (req, res) => {
        try {
            const { address, name, isAdmin, contractAddress: reqContractAddress } = req.body;
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = reqContractAddress || cfg.data?.agent_contract_address || process.env.AGENT_CONTRACT_ADDRESS;
            if (!contractAddress) {
                return res.status(400).json({ error: 'Contract not deployed' });
            }

            const serverWallet = cfg.data?.wallet;
            const provider = cfg.data?.provider;

            if (!serverWallet || !provider) {
                return res.status(500).json({ error: 'Server not configured' });
            }

            const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
            const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

            // Get gas prices with minimum
            const feeData = await ethersProvider.getFeeData();
            const minGasPrice = ethers.utils.parseUnits("30", "gwei");
            const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
            const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;
            const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
            const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);

            const contract = new ethers.Contract(contractAddress, AgentArtifact.abi, wallet);

            console.log(`Adding ${address} to list for domain ${domain}...`);

            // Convert isAdmin to role: 3=admin, 0=none
            const listName = `domain::${domain}`;
            const role = isAdmin ? 3 : 0;
            const meta = JSON.stringify({ addedBy: 'admin-ui', addedAt: new Date().toISOString() });

            const tx = await contract.addToWhitelist(listName, address, name || '', role, meta, {
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas
            });
            await tx.wait();

            console.log('Address added to list successfully');

            res.json({
                success: true,
                address: address,
                domain: domain
            });
        } catch (error) {
            console.error('Error adding to whitelist:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Remove address from whitelist
    app.post('/api/whitelist/remove', async (req, res) => {
        try {
            const { address, contractAddress: reqContractAddress } = req.body;
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = reqContractAddress || cfg.data?.agent_contract_address || process.env.AGENT_CONTRACT_ADDRESS;
            if (!contractAddress) {
                return res.status(400).json({ error: 'Contract not deployed' });
            }

            const serverWallet = cfg.data?.wallet;
            const provider = cfg.data?.provider;

            if (!serverWallet || !provider) {
                return res.status(500).json({ error: 'Server not configured' });
            }

            const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
            const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

            // Get gas prices with minimum
            const feeData = await ethersProvider.getFeeData();
            const minGasPrice = ethers.utils.parseUnits("30", "gwei");
            const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
            const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;
            const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
            const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);

            const contract = new ethers.Contract(contractAddress, AgentArtifact.abi, wallet);

            console.log(`Removing ${address} from list for domain ${domain}...`);
            const listName = `domain::${domain}`;
            const tx = await contract.removeFromWhitelist(listName, address, {
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas
            });
            await tx.wait();

            console.log('Address removed from list successfully');

            res.json({
                success: true,
                address: address,
                domain: domain
            });
        } catch (error) {
            console.error('Error removing from whitelist:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Update whitelist metadata (name and admin status)
    app.post('/api/whitelist/update', async (req, res) => {
        try {
            const { address, name, isAdmin, contractAddress: reqContractAddress } = req.body;
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = reqContractAddress || cfg.data?.agent_contract_address || process.env.AGENT_CONTRACT_ADDRESS;
            if (!contractAddress) {
                return res.status(400).json({ error: 'Contract not deployed' });
            }

            const serverWallet = cfg.data?.wallet;
            const provider = cfg.data?.provider;

            if (!serverWallet || !provider) {
                return res.status(500).json({ error: 'Server not configured' });
            }

            const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
            const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

            // Get gas prices with minimum
            const feeData = await ethersProvider.getFeeData();
            const minGasPrice = ethers.utils.parseUnits("30", "gwei");
            const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
            const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;
            const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
            const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);

            const contract = new ethers.Contract(contractAddress, AgentArtifact.abi, wallet);

            console.log(`Updating list entry for ${address}...`);

            // Use sentinel values to update only the fields that are provided
            // "\x00KEEP" for strings means don't update, 255 for role means don't update
            const listName = `domain::${domain}`;
            const role = isAdmin !== undefined ? (isAdmin ? 3 : 0) : 255;
            const nameToUpdate = name !== undefined ? name : '\x00KEEP';
            const metaToUpdate = '\x00KEEP'; // Don't update meta for now

            const tx = await contract.updateWhitelistEntry(listName, address, nameToUpdate, role, metaToUpdate, {
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas
            });
            await tx.wait();

            console.log('List entry updated successfully');

            res.json({
                success: true,
                address: address,
                name: name,
                isAdmin: isAdmin
            });
        } catch (error) {
            console.error('Error updating whitelist metadata:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Get access policy
    app.get('/api/policy', async (req, res) => {
        try {
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const policy = cfg.data?.access_policy || 'public';

            res.json({ policy: policy });
        } catch (error) {
            console.error('Error getting policy:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Set access policy
    app.post('/api/policy/set', async (req, res) => {
        try {
            const { policy } = req.body;
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const validPolicies = ['public', 'public-id', 'public-req', 'private'];
            if (!validPolicies.includes(policy)) {
                return res.status(400).json({ error: 'Invalid policy' });
            }

            cfg.data.access_policy = policy;
            cfg.save();

            console.log(`Access policy for ${domain} set to: ${policy}`);

            res.json({
                success: true,
                policy: policy,
                domain: domain
            });
        } catch (error) {
            console.error('Error setting policy:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Static files (after specific routes)
    app.use('/style', express.static(path.join(__dirname, 'public/style')));
    app.use('/image', express.static(path.join(__dirname, 'public/image')));

    // Serve qrcode library
    app.get('/lib/qrcode.js', (req, res) => {
        res.sendFile(path.join(__dirname, 'node_modules/qrcode-generator/qrcode.js'));
    });

    // Attach epistery at root
    const epistery = await Epistery.connect();
    await epistery.attach(app,'/');

    // Also mount the same routes at RFC 8615 well-known path
    // Note: We reuse the routes() to avoid duplicate middleware
    app.use('/.well-known/epistery', epistery.routes());

    config = new Config();
    const http_port = parseInt(process.env.PORT || 4080);
    const https_port = parseInt(process.env.PORTSSL || 4443);
    const certify = await Certify.attach(app);

    // Load and attach agent modules from ~/.epistery/.agents
    const agentsPath = path.join(config.configDir, '.agents');
    agentManager = new AgentManager(agentsPath);
    await agentManager.loadAll(app);

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
