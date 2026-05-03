import express from 'express';
import crypto from 'crypto';
import ethers from 'ethers';
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

// Cache: domain → { map: {addrLower: name}, expires: ms }
// Many addresses may share the same name (one user, multiple device wallets) — that's fine,
// the map is address→name only and is never reverse-queried.
const NAME_MAP_CACHE = new Map();
const NAME_MAP_TTL_MS = 60_000;

/**
 * Normalize agent name: strip leading @ for on-chain key consistency.
 * "@epistery/wiki" → "epistery/wiki", "epistery/wiki" → "epistery/wiki"
 */
export function normalizeAgentName(name) {
    return name ? name.replace(/^@/, '') : name;
}

export class DomainAcl {
    constructor(domain) {
        this.domain = domain;
        this.config = new Config();
        this.config.setPath(domain);
        this.chain = new DomainChain(domain);
    }

    /**
     * Build (or return cached) address → display-name map for this domain by walking
     * all ACL lists on the contract. Names are not unique — multiple device addresses
     * for the same person may share a name. Last non-empty name wins if a single
     * address appears in multiple lists with different names.
     * @returns {Promise<Map<string,string>>} keys are lowercased addresses
     */
    async getNameMap() {
        const cached = NAME_MAP_CACHE.get(this.domain);
        if (cached && cached.expires > Date.now()) return cached.map;

        const map = new Map();
        try {
            const contract = this.chain.contract;
            if (contract) {
                const listNames = await contract.getListNames();
                for (const listName of listNames) {
                    const entries = await contract.getACL(listName);
                    for (const e of entries) {
                        if (e.name && e.addr) {
                            map.set(e.addr.toLowerCase(), e.name);
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[DomainAcl] getNameMap failed:', err.message);
        }

        NAME_MAP_CACHE.set(this.domain, { map, expires: Date.now() + NAME_MAP_TTL_MS });
        return map;
    }

    /** Look up a single alias name for an address, or null if none. */
    async getNameForAddress(address) {
        if (!address) return null;
        const map = await this.getNameMap();
        return map.get(address.toLowerCase()) || null;
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
    loadInviteMetadata() {
        try {
            const data = this.config.readFile('invite-metadata.json');
            return JSON.parse(data.toString('utf8'));
        } catch (e) {
            return {};
        }
    }
    saveInviteMetadata(metadata) {
        this.config.writeFile('invite-metadata.json', JSON.stringify(metadata, null, 2));
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
                // DomainAgent automatically grants admin access to owner and host
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
     * @param {object} [defaultAclStance] - Optional per-agent default ACL stance (overrides global default)
     * @returns {Promise<{allowed: boolean, level: number, strategy: string}>}
     */
    async checkAgentAccess(agentName, userAddress, domain, customAuthFunctions = {}, defaultAclStance = null) {
        agentName = normalizeAgentName(agentName);
        const contract = this.chain.contract;
        const fallback = defaultAclStance || DEFAULT_ACL_STANCE;

        // No contract deployed - fall back to config-based check
        if (!contract) {
            const isAdmin = this.config.data.admin_address &&
                userAddress?.toLowerCase() === this.config.data.admin_address.toLowerCase();
            return {
                allowed: isAdmin,
                level: isAdmin ? 3 : 0,
                enableRequestAccess: fallback.enableRequestAccess ?? true
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

        const aclStance = agentConfig.aclStance || fallback;
        const acl = aclStance.acl || fallback.acl;
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

    async redeemInvite(code, redeemerAddress) {
        const contract = this.chain.contract;
        if (!contract) throw new Error('Contract not deployed');

        const codeHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(code));

        // Check invite exists and is unconsumed
        const invite = await contract.getInvite(codeHash);
        if (invite.consumed) throw new Error('Invite already used or revoked');

        // Look up the name from invite metadata
        const metadata = this.loadInviteMetadata();
        const name = metadata[codeHash]?.name || '';

        // Redeem on-chain (atomically adds to ACL)
        const feeData = await this.chain.getFeeData();
        const tx = await contract.redeemInvite(codeHash, redeemerAddress, name, feeData);
        await tx.wait();

        return { listName: invite.listName, role: invite.role };
    }

    static attach(router) {
        router.use((req, res, next) => {
            try {
                req.domainAcl = new DomainAcl(req.hostname);
            } catch(e) {}
            next();
        })

        // Invite auto-redeem: check ?invite= query param
        router.use(async (req, res, next) => {
            const code = req.query.invite;
            if (!code) return next();
            if (!req.episteryClient?.address) {
                // No wallet yet — store in cookie for deferred redemption
                res.cookie('_pending_invite', code, { maxAge: 3600000, httpOnly: true, sameSite: 'lax' });
                return next();
            }
            try {
                await req.domainAcl.redeemInvite(code, req.episteryClient.address);
                // Redirect without ?invite= to avoid re-processing
                const url = new URL(req.originalUrl, `${req.protocol}://${req.get('host')}`);
                url.searchParams.delete('invite');
                return res.redirect(url.pathname + url.search);
            } catch (err) {
                console.log('[invite] Redeem failed:', err.message);
                req.inviteError = err.message;
                next();
            }
        });

        // Deferred: redeem cookie-stored invite after wallet creation
        router.use(async (req, res, next) => {
            const pending = req.cookies?._pending_invite;
            if (!pending || !req.episteryClient?.address) return next();
            try {
                await req.domainAcl.redeemInvite(pending, req.episteryClient.address);
            } catch (err) {
                console.log('[invite] Deferred redeem failed:', err.message);
            }
            res.clearCookie('_pending_invite', { path: '/' });
            next();
        });

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
                const agent = normalizeAgentName(req.params.agent);
                const domainChain = req.domainAcl.chain;
                if (!domainChain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                // Get agent config from contract public attributes
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
                NAME_MAP_CACHE.delete(domainChain.domain);

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
                NAME_MAP_CACHE.delete(domainChain.domain);

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
                NAME_MAP_CACHE.delete(domainChain.domain);

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
                const agent = normalizeAgentName(req.body.agent);
                const { acl, authConfig } = req.body;
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
                const agent = normalizeAgentName(req.body.agent);
                const { authConfig } = req.body;
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

        // API: Create invite code (admin only)
        router.post('/api/acl/invite/create', async (req, res) => {
            try {
                const isAdmin = await req.domainAcl.isAdmin(req.episteryClient?.address);
                if (!isAdmin) {
                    return res.status(403).json({ error: 'Not authorized' });
                }

                const { listName, role, targetPath, name, comment } = req.body;
                const domainChain = req.domainAcl.chain;
                if (!domainChain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                const aclList = listName || 'epistery::reader';
                const aclRole = role !== undefined ? role : 1;
                const path = targetPath || '/';

                // Generate random invite code
                const code = crypto.randomBytes(16).toString('hex');
                const codeHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(code));

                const feeData = await domainChain.getFeeData();
                const tx = await domainChain.contract.createInvite(codeHash, aclList, aclRole, feeData);
                await tx.wait();

                // Store metadata locally (not on-chain)
                const metadata = req.domainAcl.loadInviteMetadata();
                metadata[codeHash] = { name: name || '', comment: comment || '', code, targetPath: path };
                req.domainAcl.saveInviteMetadata(metadata);

                // Build invite URL
                const inviteUrl = `${req.protocol}://${req.get('host')}${path}${path.includes('?') ? '&' : '?'}invite=${code}`;

                res.json({
                    success: true,
                    code,
                    codeHash,
                    inviteUrl,
                    listName: aclList,
                    role: aclRole
                });
            } catch (error) {
                console.error('[invite] Create failed:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // API: List all invites (admin only)
        router.get('/api/acl/invites', async (req, res) => {
            try {
                const isAdmin = await req.domainAcl.isAdmin(req.episteryClient?.address);
                if (!isAdmin) {
                    return res.status(403).json({ error: 'Not authorized' });
                }

                const domainChain = req.domainAcl.chain;
                if (!domainChain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                const invites = await domainChain.contract.getInvites();
                const metadata = req.domainAcl.loadInviteMetadata();
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                const formatted = invites.map(inv => {
                    const meta = metadata[inv.codeHash] || {};
                    const entry = {
                        codeHash: inv.codeHash,
                        listName: inv.listName,
                        role: inv.role,
                        createdBy: inv.createdBy,
                        createdAt: inv.createdAt.toNumber() * 1000,
                        consumed: inv.consumed,
                        consumedBy: inv.consumedBy,
                        consumedAt: inv.consumedAt.toNumber() * 1000,
                        name: meta.name || '',
                        comment: meta.comment || ''
                    };
                    if (!inv.consumed && meta.code) {
                        const path = meta.targetPath || '/';
                        entry.inviteUrl = `${baseUrl}${path}${path.includes('?') ? '&' : '?'}invite=${meta.code}`;
                    }
                    return entry;
                });

                res.json({ invites: formatted });
            } catch (error) {
                console.error('[invite] List failed:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // API: Revoke invite (admin only)
        router.post('/api/acl/invite/revoke', async (req, res) => {
            try {
                const isAdmin = await req.domainAcl.isAdmin(req.episteryClient?.address);
                if (!isAdmin) {
                    return res.status(403).json({ error: 'Not authorized' });
                }

                const { codeHash } = req.body;
                if (!codeHash) {
                    return res.status(400).json({ error: 'codeHash required' });
                }

                const domainChain = req.domainAcl.chain;
                if (!domainChain.contract) {
                    return res.status(400).json({ error: 'Contract not deployed' });
                }

                const feeData = await domainChain.getFeeData();
                const tx = await domainChain.contract.revokeInvite(codeHash, feeData);
                await tx.wait();

                res.json({ success: true });
            } catch (error) {
                console.error('[invite] Revoke failed:', error);
                res.status(500).json({ error: error.message });
            }
        });

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
