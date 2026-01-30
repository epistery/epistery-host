import express from 'express';
import { createRequire } from 'module';
import { Config } from 'epistery';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const ethers = require('ethers');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load DomainAgent contract artifact
const DomainAgentArtifact = JSON.parse(
    readFileSync(path.join(__dirname, 'artifacts/contracts/DomainAgent.sol/DomainAgent.json'), 'utf8')
);

// Helper functions for pending requests JSON file using Config
function loadPendingRequests(domain) {
    const cfg = new Config();
    cfg.setPath(domain);

    try {
        const data = cfg.readFile('pending-requests.json');
        return JSON.parse(data.toString('utf8'));
    } catch (e) {
        // File doesn't exist or invalid JSON
        return [];
    }
}

function savePendingRequests(domain, requests) {
    const cfg = new Config();
    cfg.setPath(domain);
    cfg.writeFile('pending-requests.json', JSON.stringify(requests, null, 2));
}

// Helper to get contract instance with server wallet
async function getContract(contractAddress, domain) {
    const cfg = new Config();
    cfg.setPath(domain);

    const serverWallet = cfg.data?.wallet;
    const provider = cfg.data?.provider;

    if (!serverWallet || !provider) {
        throw new Error('Server wallet or provider not configured');
    }

    const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
    const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

    return new ethers.Contract(contractAddress, DomainAgentArtifact.abi, wallet);
}

// Helper to check if user is admin
async function isUserAdmin(req) {
    if (!req.episteryClient) {
        return false;
    }

    try {
        const domain = req.headers.host?.split(':')[0] || 'localhost';
        const cfg = new Config();
        cfg.setPath(domain);

        const contractAddress = cfg.data?.contract_address;
        if (!contractAddress) {
            return false;
        }

        const contract = await getContract(contractAddress, domain);
        return await contract.isInACL('epistery::admin', req.episteryClient.address);
    } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
    }
}

/**
 * Check agent access based on ACL configuration
 * @param {string} agentName - Name of the agent
 * @param {string} userAddress - User's wallet address
 * @param {string} domain - Domain name
 * @param {object} customAuthFunctions - Object mapping function names to async functions
 * @returns {Promise<{allowed: boolean, level: number, strategy: string}>}
 */
export async function checkAgentAccess(agentName, userAddress, domain, customAuthFunctions = {}) {
    const cfg = new Config();
    cfg.setPath(domain);

    const contractAddress = cfg.data?.contract_address;
    if (!contractAddress) {
        return { allowed: false, level: 0, strategy: 'no-contract' };
    }

    const contract = await getContract(contractAddress, domain);

    // Get agent config from contract
    const configJson = await contract.getPublicAttribute(contract.signer.address, agentName);
    let agentConfig = {};
    if (configJson) {
        try {
            agentConfig = JSON.parse(configJson);
        } catch (e) {
            console.error(`[checkAgentAccess] Error parsing config for ${agentName}:`, e);
        }
    }

    // Default aclStance - epistery::admin always has admin access, default denies
    const defaultAclStance = {
        acl: [
            { list: 'epistery::admin', access: 3 },
            { list: 'default', access: 0 }
        ],
        enableRequestAccess: false
    };

    const aclStance = agentConfig.aclStance || defaultAclStance;
    const acl = aclStance.acl || defaultAclStance.acl;

    let defaultEntry = null;

    // Check if user is in any named ACL list (skip 'default')
    for (const entry of acl) {
        const listName = entry.list;
        const accessLevel = parseInt(entry.access);

        // Save default entry for later
        if (listName === 'default') {
            defaultEntry = entry;
            continue;
        }

        // Check contract ACL for named lists
        try {
            const contract = await getContract(contractAddress, domain);
            const isInList = await contract.isInACL(contract.signer.address, listName, userAddress);
            if (isInList) {
                return {
                    allowed: accessLevel > 0,
                    level: accessLevel,
                    strategy: 'acl-list',
                    list: listName,
                    enableRequestAccess: aclStance.enableRequestAccess || false
                };
            }
        } catch (error) {
            console.error(`[checkAgentAccess] Error checking ACL list ${listName}:`, error);
        }
    }

    // User not in any named list - apply default entry
    if (!defaultEntry) {
        defaultEntry = { list: 'default', access: 0 };
    }

    const defaultAccess = parseInt(defaultEntry.access);
    return {
        allowed: defaultAccess > 0,
        level: defaultAccess,
        strategy: 'default',
        enableRequestAccess: aclStance.enableRequestAccess || false
    };
}

/**
 * Express middleware to check agent access
 * Usage: app.use('/agent/myagent', agentAccessMiddleware('myagent', customAuthFunctions))
 */
export function agentAccessMiddleware(agentName, customAuthFunctions = {}) {
    return async (req, res, next) => {
        if (!req.episteryClient) {
            return res.status(403).json({ error: 'Authentication required' });
        }

        const domain = req.hostname || 'localhost';
        const userAddress = req.episteryClient.address;

        const result = await checkAgentAccess(agentName, userAddress, domain, customAuthFunctions);

        if (!result.allowed) {
            // enableRequestAccess is already checked in checkAgentAccess result
            return res.status(403).json({
                error: 'Access denied',
                enableRequestAccess: result.enableRequestAccess || false,
                agentName
            });
        }

        // Attach access info to request
        req.agentAccess = result;
        next();
    };
}

/**
 * ACL Routes - Access Control List management for DomainAgent
 * These routes must be mounted AFTER epistery.attach() to have req.episteryClient available
 */
export function createAclRouter() {
    const router = express.Router();

    // API: Get all ACL list names from contract
    router.get('/api/acl/lists', async (req, res) => {
        try {
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = cfg.data?.contract_address || process.env.CONTRACT_ADDRESS;
            if (!contractAddress) {
                return res.status(400).json({ error: 'Contract not deployed' });
            }

            const contract = await getContract(contractAddress, domain);
            const listNames = await contract.getListNames();

            res.json({
                lists: listNames
            });
        } catch (error) {
            console.error('Error getting list names:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Get agent ACL configuration from contract
    router.get('/api/acl', async (req, res) => {
        try {
            const agent = req.query.agent;
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            // If agent is specified, return agent-specific ACL config from contract
            if (agent) {
                const contractAddress = cfg.data?.contract_address || process.env.CONTRACT_ADDRESS;
                if (!contractAddress) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                const contract = await getContract(contractAddress, domain);

                // Get agent config from contract public attributes
                // Key is the agent name (e.g., "@epistery/wiki")
                const configJson = await contract.getPublicAttribute(contract.signer.address, agent);

                let agentConfig = {};
                if (configJson) {
                    try {
                        agentConfig = JSON.parse(configJson);
                    } catch (e) {
                        console.error('[acl] Error parsing agent config:', e);
                    }
                }

                // Default ACL configuration - epistery::admin has admin access, default denies
                const defaultAclStance = {
                    acl: [
                        { list: 'epistery::admin', access: 3 },
                        { list: 'default', access: 0 }
                    ],
                    enableRequestAccess: false
                };

                const aclStance = agentConfig.aclStance || defaultAclStance;

                return res.json({
                    domain,
                    agent,
                    acl: aclStance.acl || defaultAclStance.acl,
                    authConfig: {
                        enableRequestAccess: aclStance.enableRequestAccess || false
                    }
                });
            }

            // Otherwise return domain-level ACL (legacy behavior)
            const listName = req.query.listName || 'epistery::admin';
            const contractAddress = cfg.data?.contract_address || process.env.CONTRACT_ADDRESS;
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
            const contract = new ethers.Contract(contractAddress, DomainAgentArtifact.abi, wallet);

            // Get list from contract (returns ACLEntry[] with addr, name, role, meta)
            const aclEntries = await contract.getACL(listName);

            // Transform to simple format for API response
            const acl = aclEntries.map(entry => entry.addr);
            const metadata = {};
            aclEntries.forEach(entry => {
                metadata[entry.addr.toLowerCase()] = {
                    name: entry.name
                };
            });

            res.json({
                domain: domain,
                listName: listName,
                acl: acl,
                metadata: metadata,
                count: acl.length
            });
        } catch (error) {
            console.error('Error getting acl:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Add address to acl
    router.post('/api/acl/add', async (req, res) => {
        try {
            const { address, name, listName: reqListName, contractAddress: reqContractAddress } = req.body;
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = reqContractAddress || cfg.data?.contract_address || process.env.CONTRACT_ADDRESS;
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

            const contract = new ethers.Contract(contractAddress, DomainAgentArtifact.abi, wallet);

            const listName = reqListName || 'epistery::admin';
            console.log(`Adding ${address} to list ${listName} for domain ${domain}...`);

            // Default role is 2 (write access)
            const role = 2;
            const meta = JSON.stringify({ addedBy: 'admin-ui', addedAt: new Date().toISOString() });

            const tx = await contract.addToACL(listName, address, name || '', role, meta, {
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas
            });
            await tx.wait();

            console.log('Address added to list successfully');

            res.json({
                success: true,
                address: address,
                listName: listName,
                domain: domain
            });
        } catch (error) {
            console.error('Error adding to acl:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Remove address from acl
    router.post('/api/acl/remove', async (req, res) => {
        try {
            const { address, listName: reqListName, contractAddress: reqContractAddress } = req.body;
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = reqContractAddress || cfg.data?.contract_address || process.env.CONTRACT_ADDRESS;
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

            const contract = new ethers.Contract(contractAddress, DomainAgentArtifact.abi, wallet);

            const listName = reqListName || 'epistery::admin';
            console.log(`Removing ${address} from list ${listName} for domain ${domain}...`);
            const tx = await contract.removeFromACL(listName, address, {
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                maxFeePerGas: maxFeePerGas
            });
            await tx.wait();

            console.log('Address removed from list successfully');

            res.json({
                success: true,
                address: address,
                listName: listName,
                domain: domain
            });
        } catch (error) {
            console.error('Error removing from acl:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Update acl metadata (name and admin status)
    router.post('/api/acl/update', async (req, res) => {
        try {
            const { address, name, isAdmin, listName: reqListName, contractAddress: reqContractAddress } = req.body;
            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = reqContractAddress || cfg.data?.contract_address || process.env.CONTRACT_ADDRESS;
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

            const contract = new ethers.Contract(contractAddress, DomainAgentArtifact.abi, wallet);

            // Use sentinel values to update only the fields that are provided
            // "\x00KEEP" for strings means don't update, 255 for role means don't update
            const listName = reqListName || 'epistery::admin';

            console.log(`Updating list entry for ${address} in list ${listName}...`);
            const role = isAdmin !== undefined ? (isAdmin ? 3 : 0) : 255;
            const nameToUpdate = name !== undefined ? name : '\x00KEEP';
            const metaToUpdate = '\x00KEEP'; // Don't update meta for now

            const tx = await contract.updateACLEntry(listName, address, nameToUpdate, role, metaToUpdate, {
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
            console.error('Error updating acl metadata:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Save agent ACL configuration to contract
    router.put('/api/acl', async (req, res) => {
        try {
            const { agent, acl } = req.body;
            if (!agent || !Array.isArray(acl)) {
                return res.status(400).json({ error: 'Agent name and ACL array required' });
            }

            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = cfg.data?.contract_address || process.env.CONTRACT_ADDRESS;
            if (!contractAddress) {
                return res.status(400).json({ error: 'Contract not deployed' });
            }

            const contract = await getContract(contractAddress, domain);

            // Get existing agent config from contract
            const configJson = await contract.getPublicAttribute(contract.signer.address, agent);
            let agentConfig = {};
            if (configJson) {
                try {
                    agentConfig = JSON.parse(configJson);
                } catch (e) {
                    console.error('[acl] Error parsing existing config:', e);
                }
            }

            // Update aclStance.acl
            if (!agentConfig.aclStance) {
                agentConfig.aclStance = {};
            }
            agentConfig.aclStance.acl = acl;

            // Save back to contract
            const feeData = await contract.provider.getFeeData();
            const minGasPrice = ethers.utils.parseUnits("30", "gwei");
            const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
            const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;
            const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
            const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);

            const tx = await contract.setPublicAttribute(agent, JSON.stringify(agentConfig), {
                maxPriorityFeePerGas,
                maxFeePerGas
            });
            await tx.wait();

            res.json({ success: true, agent, acl });
        } catch (error) {
            console.error('Error saving agent ACL:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Save enableRequestAccess to contract
    router.put('/api/acl/auth-strategy', async (req, res) => {
        try {
            const { agent, authConfig } = req.body;
            if (!agent || !authConfig) {
                return res.status(400).json({ error: 'Agent name and authConfig required' });
            }

            const domain = req.hostname || 'localhost';
            const cfg = new Config();
            cfg.setPath(domain);

            const contractAddress = cfg.data?.contract_address || process.env.CONTRACT_ADDRESS;
            if (!contractAddress) {
                return res.status(400).json({ error: 'Contract not deployed' });
            }

            const contract = await getContract(contractAddress, domain);

            // Get existing agent config from contract
            const configJson = await contract.getPublicAttribute(contract.signer.address, agent);
            let agentConfig = {};
            if (configJson) {
                try {
                    agentConfig = JSON.parse(configJson);
                } catch (e) {
                    console.error('[acl] Error parsing existing config:', e);
                }
            }

            // Update aclStance.enableRequestAccess
            if (!agentConfig.aclStance) {
                agentConfig.aclStance = {};
            }
            agentConfig.aclStance.enableRequestAccess = authConfig.enableRequestAccess;

            // Save back to contract
            const feeData = await contract.provider.getFeeData();
            const minGasPrice = ethers.utils.parseUnits("30", "gwei");
            const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
            const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;
            const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
            const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);

            const tx = await contract.setPublicAttribute(agent, JSON.stringify(agentConfig), {
                maxPriorityFeePerGas,
                maxFeePerGas
            });
            await tx.wait();

            res.json({ success: true, agent, authConfig });
        } catch (error) {
            console.error('Error saving request access setting:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Request access to ACL (for non-admins)
    // Support both old whitelist path and new ACL path
    const requestAccessHandler = async (req, res) => {
        try {
            const { address, listName, agentName, message, name } = req.body;
            const domain = req.headers.host?.split(':')[0] || 'localhost';

            console.log('[request-access] Received request:', { address, listName, agentName, domain });

            if (!address || typeof address !== 'string' || !listName) {
                return res.status(400).json({ success: false, error: 'Valid address and list name required' });
            }

            // Load pending requests from JSON file
            const pendingRequests = loadPendingRequests(domain);
            console.log('[request-access] Loaded', pendingRequests.length, 'pending requests');

            // Check if already requested
            const existing = pendingRequests.find(
                r => r.address.toLowerCase() === address.toLowerCase() && r.listName === listName
            );

            if (existing) {
                console.log('[request-access] Request already exists');
                return res.json({
                    success: true,
                    alreadyRequested: true,
                    message: 'Access request already pending'
                });
            }

            const newRequest = {
                address,
                listName,
                agentName: agentName || 'unknown',
                message: message || '',
                name: name || '',
                requestedAt: new Date().toISOString(),
                status: 'pending'
            };

            console.log('[request-access] Adding request:', newRequest);
            pendingRequests.push(newRequest);

            // Save to JSON file
            savePendingRequests(domain, pendingRequests);
            console.log('[request-access] Saved', pendingRequests.length, 'pending requests');

            res.json({ success: true, message: 'Access request submitted' });
        } catch (error) {
            console.error('[request-access] Error submitting access request:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    };

    // Register both paths for backward compatibility
    router.post('/api/acl/request-access', requestAccessHandler);
    router.post('/.well-known/epistery/whitelist/request-access', requestAccessHandler);

    // API: Check if current user has access to an agent
    router.get('/api/acl/check-access', async (req, res) => {
        try {
            const { agent } = req.query;

            if (!agent) {
                return res.status(400).json({ error: 'Agent name required' });
            }

            if (!req.episteryClient) {
                return res.json({ allowed: false, level: 0 });
            }

            const domain = req.headers.host?.split(':')[0] || 'localhost';
            const result = await checkAgentAccess(agent, req.episteryClient.address, domain);

            res.json({
                allowed: result.allowed,
                level: result.level,
                address: req.episteryClient.address
            });
        } catch (error) {
            console.error('[check-access] Error:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Get pending access requests (admin only)
    router.get('/api/acl/pending-requests', async (req, res) => {
        try {
            console.log('[pending-requests] GET request received');

            if (!req.episteryClient) {
                console.log('[pending-requests] No episteryClient - witness authentication not complete');
                return res.status(403).json({ error: 'Not authorized - authentication required' });
            }

            const domain = req.headers.host?.split(':')[0] || 'localhost';
            console.log('[pending-requests] Domain:', domain);

            const cfg = new Config();
            cfg.setPath(domain);
            console.log('[pending-requests] Config file path:', cfg.currentFile);
            console.log('[pending-requests] Config data:', JSON.stringify(cfg.data, null, 2));

            const contractAddress = cfg.data?.contract_address;
            if (!contractAddress) {
                return res.status(400).json({ error: 'Contract not deployed' });
            }

            const contract = await getContract(contractAddress, domain);
            const isInAdminList = await contract.isInACL('epistery::admin', req.episteryClient.address);
            console.log('[pending-requests] User is in admin list:', isInAdminList);

            if (!isInAdminList) {
                return res.status(403).json({ error: 'Not authorized' });
            }

            // Load from JSON file
            const allRequests = loadPendingRequests(domain);
            const requests = allRequests.filter(r => r.status === 'pending');
            console.log('[pending-requests] Pending requests found:', requests.length);

            res.json({ requests });
        } catch (error) {
            console.error('[pending-requests] Error loading pending requests:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // API: Handle access request (approve/deny) (admin only)
    router.post('/api/acl/handle-request', async (req, res) => {
        try {
            const isAdmin = await isUserAdmin(req);
            if (!isAdmin) {
                return res.status(403).json({ error: 'Not authorized' });
            }

            const { address, listName, action } = req.body;
            const domain = req.headers.host?.split(':')[0] || 'localhost';

            if (!address || !listName || !action) {
                return res.status(400).json({ error: 'Missing required fields' });
            }

            const cfg = new Config();
            cfg.setPath(domain);

            // Load from JSON file
            const allRequests = loadPendingRequests(domain);

            const requestIndex = allRequests.findIndex(
                r => r.address.toLowerCase() === address.toLowerCase() &&
                     r.listName === listName &&
                     r.status === 'pending'
            );

            if (requestIndex === -1) {
                return res.status(404).json({ error: 'Request not found' });
            }

            const request = allRequests[requestIndex];

            if (action === 'approve') {
                // Add to ACL
                const contractAddress = cfg.data?.contract_address;
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

                const feeData = await ethersProvider.getFeeData();
                const minGasPrice = ethers.utils.parseUnits("30", "gwei");
                const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
                const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;
                const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
                const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);

                const contract = new ethers.Contract(contractAddress, DomainAgentArtifact.abi, wallet);

                const role = listName.includes('::admin') ? 3 : 2; // 3=admin, 2=write
                const meta = JSON.stringify({
                    addedBy: 'access-request',
                    addedAt: new Date().toISOString(),
                    requestMessage: request.message
                });

                const tx = await contract.addToACL(listName, address, request.name || '', role, meta, {
                    maxPriorityFeePerGas: maxPriorityFeePerGas,
                    maxFeePerGas: maxFeePerGas
                });
                await tx.wait();

                request.status = 'approved';
                request.approvedAt = new Date().toISOString();
            } else if (action === 'deny') {
                request.status = 'denied';
                request.deniedAt = new Date().toISOString();
            } else {
                return res.status(400).json({ error: 'Invalid action' });
            }

            // Save back to JSON file
            savePendingRequests(domain, allRequests);

            res.json({
                success: true,
                message: action === 'approve' ? 'Request approved and added to ACL' : 'Request denied'
            });
        } catch (error) {
            console.error('[acl] Error handling request:', error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
}
