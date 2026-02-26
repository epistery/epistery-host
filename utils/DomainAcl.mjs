import express from 'express';
import { Config } from 'epistery';
import { DomainChain } from './DomainChain.mjs';

// Standard default ACL stance for any agent without explicit configuration
const DEFAULT_ACL_STANCE = {
    acl: [
        { list: 'epistery::admin', access: 3 },
        { list: 'epistery::editor', access: 2 },
        { list: 'epistery::reader', access: 1 },
        { list: 'default', access: 0 }
    ],
    enableRequestAccess: true
};

export class DomainAcl {
    constructor(domain) {
        this.config = new Config();
        this.config.setPath(domain);
        this.chain = new DomainChain(domain);
    }
    loadPendingRequests() {
        try {
            const data = this.config.readFile('pending-requests.json');
            return JSON.parse(data.toString('utf8'));
        } catch (e) {
            // File doesn't exist or invalid JSON
            return [];
        }
    }
    savePendingRequests(domain, requests) {
        this.config.writeFile('pending-requests.json', JSON.stringify(requests, null, 2));
    }
    async isAdmin(address) {
        try {
            // Check if address is on the epistery::admin list using DomainAgent contract
            try {
                if (!address) return false;
                if (!this.chain.contract) {
                    // if no contract test claim state administrator
                    const isAdmin = this.config.data.admin_address &&
                      address.toLowerCase() === this.config.data.admin_address.toLowerCase();
                    return isAdmin && this.config.data.verified;
                }
                // DomainAgent automatically grants admin access to sponsor and owner
                return await this.chain.contract.isInACL('epistery::admin', address);
            } catch (error) {
                console.error('[epistery-host] Admin check error:', error);
                // On error, fallback to old admin_address check
                return this.config.data.admin_address &&
                  address.toLowerCase() === this.config.data.admin_address.toLowerCase();
            }
        } catch (error) {
            console.error('Admin check error:', error);
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
    async checkAgentAccess(agentName, userAddress, domain, customAuthFunctions = {}) {
        const contract = this.chain.contract;

        // No contract deployed - fall back to config-based check
        if (!contract) {
            const isAdmin = this.config.data.admin_address &&
                userAddress?.toLowerCase() === this.config.data.admin_address.toLowerCase();
            return {
                allowed: isAdmin,
                level: isAdmin ? 3 : 0,
                enableRequestAccess: true
            };
        }

        const configJson = await contract.getPublicAttribute(contract.signer.address, agentName);
        let agentConfig = {};
        if (configJson) {
            try {
                agentConfig = JSON.parse(configJson);
            } catch (e) {
                console.error(`[checkAgentAccess] Error parsing config for ${agentName}:`, e);
            }
        }

        const aclStance = agentConfig.aclStance || DEFAULT_ACL_STANCE;
        const acl = aclStance.acl || DEFAULT_ACL_STANCE.acl;
        // get lists and access for this address. default stance included automatically
        const membershipEntries = await contract.getListsForMember(userAddress);
        const userLists = membershipEntries.map(entry => entry.listName);
        const userTests = ['default',...userLists];
        const accessLevel = acl.reduce((level,entry)=>{
            if (userTests.includes(entry.list) && entry.access > level) level = entry.access;
            return level;
        },0);
        return {
            allowed: accessLevel > 0,
            level: accessLevel,
            enableRequestAccess: aclStance.enableRequestAccess || false
        };
    }

    static attach(router) {
        router.use((req, res, next) => {
            try {
                req.domainAcl = new DomainAcl(req.hostname);
            } catch(e) {}
            next();
        })
        router.get("/api/acl/check-admin", async (req, res) => {
            try {
                const address = req.episteryClient?.address;
                if (!address) {
                    res.clearCookie('_epistery', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
                    return res.json({ isAdmin: false, error: 'No authenticated session' });
                }
                const isAdmin = await req.domainAcl.isAdmin(address);
                res.json({ isAdmin: isAdmin });
            } catch (error) {
                res.clearCookie('_epistery', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
                res.json({ isAdmin: false, error: error.message });
            }
        });

        // API: Get all ACL list names from contract
        router.get('/api/acl/list{/:listName}', async (req, res) => {
            try {
                if (!req.domainAcl.chain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }
                const listName = req.params.listName;
                if (listName) {
                    const addresses = await req.domainAcl.chain.contract.getACL(listName);
                    res.json(addresses.map(e => ({address: e.addr, name: e.name, role: e.role, meta: e.meta})));
                } else {
                    const listNames = await req.domainAcl.chain.contract.getListNames();
                    res.json({lists: listNames});
                }
            } catch (error) {
                console.error('Error getting list names:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // API: Get agent ACL configuration from contract
        router.get('/api/acl/agent{/:agent}', async (req, res) => {
            try {
                const agent = req.params.agent;
                const domainChain = req.domainAcl.chain;
                if (!domainChain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                // Get agent config from contract public attributes
                // Key is the agent name (e.g., "@epistery/wiki")
                const configJson = await domainChain.contract.getPublicAttribute(domainChain.contract.signer.address, agent);

                let agentConfig = {};
                if (configJson) {
                    try {
                        agentConfig = JSON.parse(configJson);
                    } catch (e) {
                        console.error('[acl] Error parsing agent config:', e);
                    }
                }

                const aclStance = agentConfig.aclStance || DEFAULT_ACL_STANCE;

                return res.json({
                    domain:domainChain.domain,
                    agent,
                    acl: aclStance.acl || DEFAULT_ACL_STANCE.acl,
                    authConfig: {
                        enableRequestAccess: aclStance.enableRequestAccess !== undefined ? aclStance.enableRequestAccess : true
                    }
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
                const domainChain = req.domainAcl.chain;
                if (!domainChain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                const listName = reqListName || 'epistery::admin';
                console.log(`Adding ${address} to list ${listName} for domain ${domainChain.domain}...`);

                // Default role is 2 (write access)
                const role = 2;
                const meta = JSON.stringify({ addedBy: 'admin-ui', addedAt: new Date().toISOString() });

                const feeData = await domainChain.getFeeData();
                const tx = await domainChain.contract.addToACL(listName, address, name || '', role, meta, feeData);
                await tx.wait();

                console.log('Address added to list successfully');

                res.json({
                    success: true,
                    address: address,
                    listName: listName,
                    domain: domainChain.domain
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
                const domainChain = req.domainAcl.chain;
                if (!domainChain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                const listName = reqListName || 'epistery::admin';
                console.log(`Removing ${address} from list ${listName} for domain ${domainChain.domain}...`);
                const feeData = await domainChain.getFeeData();
                const tx = await domainChain.contract.removeFromACL(listName, address, feeData);
                await tx.wait();

                console.log('Address removed from list successfully');

                res.json({
                    success: true,
                    address: address,
                    listName: listName,
                    domain: domainChain.domain
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
                const domainChain = req.domainAcl.chain;
                if (!domainChain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                // Use sentinel values to update only the fields that are provided
                // "\x00KEEP" for strings means don't update, 255 for role means don't update
                const listName = reqListName || 'epistery::admin';

                console.log(`Updating list entry for ${address} in list ${listName}...`);
                const role = isAdmin !== undefined ? (isAdmin ? 3 : 0) : 255;
                const nameToUpdate = name !== undefined ? name : '\x00KEEP';
                const metaToUpdate = '\x00KEEP'; // Don't update meta for now

                const feeData = await domainChain.getFeeData();
                const tx = await domainChain.contract.updateACLEntry(listName, address, nameToUpdate, role, metaToUpdate, feeData);
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
        // Accepts { agent, acl, authConfig? } - writes everything in one transaction
        router.put('/api/acl/agent', async (req, res) => {
            try {
                const { agent, acl, authConfig } = req.body;
                if (!agent || !Array.isArray(acl)) {
                    return res.status(400).json({ error: 'Agent name and ACL array required' });
                }

                const domainChain = req.domainAcl.chain;
                if (!domainChain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                // Get existing agent config from contract
                const configJson = await domainChain.contract.getPublicAttribute(domainChain.contract.signer.address, agent);
                let agentConfig = {};
                if (configJson) {
                    try {
                        agentConfig = JSON.parse(configJson);
                    } catch (e) {
                        console.error('[acl] Error parsing existing config:', e);
                    }
                }

                // Update aclStance
                if (!agentConfig.aclStance) {
                    agentConfig.aclStance = {};
                }
                agentConfig.aclStance.acl = acl;
                if (authConfig) {
                    agentConfig.aclStance.enableRequestAccess = authConfig.enableRequestAccess;
                }

                const feeData = await domainChain.getFeeData();
                const tx = await domainChain.contract.setPublicAttribute(agent, JSON.stringify(agentConfig), feeData);
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

                const domainChain = req.domainAcl.chain;
                if (!domainChain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                // Get existing agent config from contract
                const configJson = await domainChain.contract.getPublicAttribute(domainChain.contract.signer.address, agent);
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

                const feeData = await domainChain.getFeeData();
                const tx = await domainChain.contract.setPublicAttribute(agent, JSON.stringify(agentConfig), feeData);
                await tx.wait();

                res.json({ success: true, agent, authConfig });
            } catch (error) {
                console.error('Error saving request access setting:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // API: Request access to ACL (for non-admins)
        const requestAccessHandler = async (req, res) => {
            try {
                const { address, listName, agentName, message, name } = req.body;
                const domain = req.hostname;

                console.log('[request-access] Received request:', { address, listName, agentName, domain });

                if (!address || typeof address !== 'string' || !listName) {
                    return res.status(400).json({ success: false, error: 'Valid address and list name required' });
                }

                // Load pending requests from JSON file
                const pendingRequests = req.domainAcl.loadPendingRequests(domain);
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
                req.domainAcl.savePendingRequests(domain, pendingRequests);
                console.log('[request-access] Saved', pendingRequests.length, 'pending requests');

                res.json({ success: true, message: 'Access request submitted' });
            } catch (error) {
                console.error('[request-access] Error submitting access request:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        };

        // Register both paths for backward compatibility
        router.post('/api/acl/request-access', requestAccessHandler);

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

                const result = await req.domainAcl.checkAgentAccess(agent, req.episteryClient.address, req.hostname);

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
                const domainChain = req.domainAcl.chain;

                // Check admin via domain config (handles fresh rivets) or contract
                const adminAddress = req.domainAcl.config.data?.admin_address;
                let isAdmin = false;

                if (req.episteryClient) {
                    // Has authenticated session - check via contract if available
                    if (domainChain.contract) {
                        isAdmin = await domainChain.contract.isInACL('epistery::admin', req.episteryClient.address);
                    } else {
                        // No contract - check against config
                        isAdmin = adminAddress && req.episteryClient.address.toLowerCase() === adminAddress.toLowerCase();
                    }
                } else {
                    // No episteryClient (fresh rivet) - allow if we're in pre-contract state
                    // This allows admin page to work immediately after domain claim
                    isAdmin = adminAddress && !domainChain.contract;
                }

                if (!isAdmin) {
                    // Clear stale session cookie on authorization failure
                    res.clearCookie('_epistery', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
                    return res.status(403).json({ error: 'Not authorized' });
                }

                // Load from JSON file
                const allRequests = req.domainAcl.loadPendingRequests(req.hostname);
                const requests = allRequests.filter(r => r.status === 'pending');

                res.json({ requests });
            } catch (error) {
                console.error('[acl] Error loading pending requests:', error);
                // Clear session cookie on error
                res.clearCookie('_epistery', { path: '/', httpOnly: true, secure: true, sameSite: 'lax' });
                res.status(500).json({ error: error.message });
            }
        });

        // API: Handle access request (approve/deny) (admin only)
        router.post('/api/acl/handle-request', async (req, res) => {
            try {
                const isAdmin = await req.domainAcl.isAdmin(req.episteryClient?.address);
                if (!isAdmin) {
                    return res.status(403).json({ error: 'Not authorized' });
                }

                const { address, listName, action } = req.body;
                if (!address || !listName || !action) {
                    return res.status(400).json({ error: 'Missing required fields' });
                }
                const domainChain = req.domainAcl.chain;

                // Load from JSON file
                const allRequests = req.domainAcl.loadPendingRequests(domainChain.domain);

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
                    const role = listName.includes('::admin') ? 3 : 2; // 3=admin, 2=write
                    const meta = JSON.stringify({
                        addedBy: 'access-request',
                        addedAt: new Date().toISOString(),
                        requestMessage: request.message
                    });

                    const feeData = await domainChain.getFeeData();
                    const tx = await domainChain.contract.addToACL(listName, address, request.name || '', role, meta, feeData);
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
                req.domainAcl.savePendingRequests(domainChain.domain, allRequests);

                res.json({
                    success: true,
                    message: action === 'approve' ? 'Request approved and added to ACL' : 'Request denied'
                });
            } catch (error) {
                console.error('[acl] Error handling request:', error);
                res.status(500).json({ error: error.message });
            }
        });
    }
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
        const userAddress = req.episteryClient.address;

        const result = await req.domainAcl.checkAgentAccess(agentName, userAddress, req.hostname, customAuthFunctions);

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
