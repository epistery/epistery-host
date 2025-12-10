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
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Wallet-Address'],
        exposedHeaders: ['X-Wallet-Address']
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


    // Build status JSON - shared by both HTML and API responses
    function buildStatus(domain, cfg) {
        const wallet = cfg.data?.wallet || {};
        const provider = cfg.data?.provider || {};
        // Only use finalized contract address for initialized status
        const contractAddress = cfg.data?.agent_contract_address || process.env.AGENT_CONTRACT_ADDRESS;
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

            // Check if there's a default agent set (and not bypassed with ?home query param)
            const defaultAgent = cfg.data?.default_agent;
            if (defaultAgent && !req.query.home && agentManager) {
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
    // Shared contract deployment logic
    async function deployAgentContract(req, res) {
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

            // Check contract version
            let version = 'Unknown';
            try {
                version = await contract.VERSION();
                console.log(`Contract version: ${version}`);
            } catch (e) {
                // Contract doesn't have VERSION field (old version)
                version = '1.0.0';
            }

            // Store in environment for current session
            process.env.AGENT_CONTRACT_ADDRESS = contractAddress;

            // Mark contract as pending until whitelist initialization completes
            cfg.data.agent_contract_pending = contractAddress;
            cfg.data.contract_deployed_at = new Date().toISOString();
            cfg.data.contract_version = version;
            cfg.save();
            console.log(`Contract deployment pending initialization: ${domain}`);

            res.json({
                success: true,
                address: contractAddress,
                contractAddress: contractAddress, // Keep for backward compatibility
                version: version,
                domain: domain,
                message: 'Agent contract deployed successfully'
            });
        } catch (error) {
            console.error('Error deploying contract:', error);
            res.status(500).json({ error: error.message });
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

            const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
            const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

            // Get current balance
            const balance = await ethersProvider.getBalance(wallet.address);

            // Estimate deployment cost
            // Gas limit ~750k, current gas prices
            const feeData = await ethersProvider.getFeeData();
            const estimatedGas = ethers.BigNumber.from(750000);
            const minGasPrice = ethers.utils.parseUnits("30", "gwei");

            let estimatedCost;
            if (feeData.maxFeePerGas) {
                const maxFee = feeData.maxFeePerGas.mul(120).div(100);
                const adjustedMaxFee = maxFee.gt(minGasPrice.mul(2)) ? maxFee : minGasPrice.mul(2);
                estimatedCost = estimatedGas.mul(adjustedMaxFee);
            } else {
                const gasPrice = feeData.gasPrice ? feeData.gasPrice.mul(120).div(100) : minGasPrice.mul(2);
                estimatedCost = estimatedGas.mul(gasPrice);
            }

            // Add 50% buffer
            const required = estimatedCost.mul(150).div(100);
            const sufficient = balance.gte(required);

            res.json({
                balance: ethers.utils.formatEther(balance),
                estimatedCost: ethers.utils.formatEther(estimatedCost),
                required: ethers.utils.formatEther(required),
                sufficient: sufficient
            });
        } catch (error) {
            console.error('Balance check error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/deploy-agent', deployAgentContract);
    app.post('/api/contract/deploy', deployAgentContract);

    // API: Request deployment help from epistery.host admins
    app.post('/api/request-deployment-help', async (req, res) => {
        try {
            const { domain, walletAddress, requesterRivet } = req.body;

            if (!domain || !walletAddress || !requesterRivet) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            // Create a deployment help request (similar to white-list pending request)
            // This would be stored and shown to epistery.host admins
            console.log('[deployment-help] Request received:', {
                domain,
                walletAddress,
                requesterRivet,
                timestamp: new Date().toISOString()
            });

            // TODO: Store in database or file system for admin review
            // For now, just log it

            res.json({
                success: true,
                message: 'Help request submitted. An administrator will review your request.'
            });
        } catch (error) {
            console.error('Deployment help request error:', error);
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

            console.log(`Adding ${adminAddress} to epistery::admin list for domain ${domain}...`);

            // Add to epistery::admin list with admin role (3) and metadata
            const listName = 'epistery::admin';
            const role = 3; // admin
            const name = 'Epistery Administrator';
            const meta = JSON.stringify({ addedBy: 'initialization', addedAt: new Date().toISOString() });

            const tx = await contract.addToWhitelist(listName, adminAddress, name, role, meta, {
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas,
                gasLimit: 300000  // Set explicit gas limit for whitelist operation
            });
            await tx.wait();

            console.log('Admin address added to list successfully');

            // Promote pending contract to finalized
            if (cfg.data.agent_contract_pending) {
                cfg.data.agent_contract_address = cfg.data.agent_contract_pending;
                delete cfg.data.agent_contract_pending;
                cfg.data.whitelist_initialized_at = new Date().toISOString();
                cfg.save();
                console.log(`Initialization complete for domain: ${domain}`);
            }

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

            const listName = `${domain}::admin`;
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
            const listName = `${domain}::admin`;
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
            const listName = `${domain}::admin`;
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
            const listName = `${domain}::admin`;
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
            const listName = `${domain}::admin`;
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
    app.use('/script', express.static(path.join(__dirname, 'public/script')));

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
        if (req.episteryClient && req.app.locals.epistery) {
            try {
                isAdmin = await req.app.locals.epistery.isListed(req.episteryClient.address, 'epistery::admin');
            } catch (error) {
                console.error('[nav-menu] Error checking admin status:', error);
            }
        }

        let navBar = "";
        for (const [, agentData] of agentManager.agents) {
            if (agentData.manifest.noUserInterface) continue;
            const displayName = agentData.manifest.title || agentData.manifest.name.split('/').pop();
            navBar += `<a href="${agentData.shortPath}"><img alt="${displayName}" src="${agentData.manifest.icon}"> <span>${displayName}</span></a>`;
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

            if (!agentName) {
                return res.status(400).json({ error: 'agentName is required' });
            }

            // Check if user is admin
            if (!req.episteryClient || !req.app.locals.epistery) {
                return res.status(401).json({ error: 'Not authenticated' });
            }

            const isAdmin = await req.app.locals.epistery.isListed(req.episteryClient.address, 'epistery::admin');
            if (!isAdmin) {
                return res.status(403).json({ error: 'Not authorized' });
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
            if (!req.episteryClient || !req.app.locals.epistery) {
                return res.status(401).json({ error: 'Not authenticated' });
            }

            const isAdmin = await req.app.locals.epistery.isListed(req.episteryClient.address, 'epistery::admin');
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

    // Initialize WebSocket servers for agents that support it
    if (agentManager) {
        for (const [, agentData] of agentManager.agents) {
            if (agentData.instance && typeof agentData.instance.initWebSocket === 'function') {
                try {
                    agentData.instance.initWebSocket(http_server);
                    console.log(`WebSocket initialized for agent: ${agentData.manifest.name}`);
                } catch (error) {
                    console.error(`Failed to initialize WebSocket for ${agentData.manifest.name}:`, error);
                }
            }
        }
    }

    http_server.listen(http_port);
    http_server.on('error', console.error);
    http_server.on('listening',()=>{
        let address = http_server.address();
        console.log(`Listening on ${address.address} ${address.port} (${address.family})`);
    });
    agentManager.initializeWebSockets(https_server);
    agentManager.initializeWebSockets(http_server);
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
