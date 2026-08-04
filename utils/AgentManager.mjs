import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import express from 'express';
import StorageFactory from './storage/StorageFactory.mjs';
import EncryptedStorage from './storage/EncryptedStorage.mjs';
import keyManager from './KeyManager.mjs';
import { MasterKey } from './crypto/master-key.mjs';
import { ECDH } from './crypto/ecdh.mjs';
import { PACKAGE_TYPES, VERSIONS } from './crypto/types.mjs';
import { normalizeAgentName } from './DomainAcl.mjs';
import { gitCredential } from './gitCredentials.mjs';

/**
 * AgentManager - Discovers and loads epistery agent modules
 *
 * Agent modules are located in ~/.epistery/.agents/
 * Each agent has an epistery.json manifest describing its capabilities
 * Agents are automatically namespaced under:
 *   - /.well-known/epistery/agent/{name}/*
 *   - /agent/{name}/*
 * where {name} is derived from the npm package name with @ removed
 * (e.g., "@geistm/adnet-agent" → "geistm/adnet-agent")
 *
 * Manifest fields:
 * - name: npm package name (e.g., "@geistm/adnet-agent") - used for routing
 * - version: semantic version
 * - main: entry point file (e.g., "index.mjs")
 * - command: shell command to start agent (defaults to "npm start")
 * - config: configuration passed to agent constructor
 * - permissions: array of epistery permissions required
 * - tools: optional array of tool declarations for dynamic discovery
 *     Each tool: { name, description, method, path, inputSchema }
 *     path supports {param} substitution from input args
 */
export class AgentManager {
    constructor(agentsPath, options = {}) {
        this.agentsPath = agentsPath;
        this.agents = new Map();
        this.toolRegistry = []; // collected from agent manifests
        this.externalTools = new Map(); // peerId -> tools[] (from bridge peers)
        this.contractArtifact = options.contractArtifact || null;
        // Resolves a git credential for a host/org at fetch time: (host, org) =>
        // Promise<token|null>. Injected so this class stays ignorant of where
        // GitHub PATs are configured — see index.mjs.
        this.gitAuth = options.gitAuth || null;
    }

    /**
     * Discover all agent modules in the .agents directory
     */
    discover() {
        if (!existsSync(this.agentsPath)) {
            console.log('No .agents directory found:', this.agentsPath);
            return [];
        }

        const discovered = [];
        const entries = readdirSync(this.agentsPath, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

            const agentDir = join(this.agentsPath, entry.name);
            const manifestPath = join(agentDir, 'epistery.json');
            const entryPath = join(agentDir, 'index.mjs');

            // Check for required files
            if (!existsSync(manifestPath)) {
                console.warn(`Agent ${entry.name} missing epistery.json, skipping`);
                continue;
            }

            if (!existsSync(entryPath)) {
                console.warn(`Agent ${entry.name} missing index.mjs, skipping`);
                continue;
            }

            try {
                const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
                if (!manifest.name) {
                    console.warn(`Agent ${entry.name} has no name in epistery.json, skipping`);
                    continue;
                }
                discovered.push({
                    name: normalizeAgentName(manifest.name),  // identity comes from the manifest, not the folder
                    path: agentDir,                            // folder location (basename = entry.name)
                    manifest,
                    entryPath
                });
                console.log(`Discovered agent: ${manifest.name} v${manifest.version}`);
            } catch (error) {
                console.error(`Failed to load agent ${entry.name}:`, error.message);
            }
        }

        return discovered;
    }

    /**
     * Load and initialize all discovered agents
     */
    async loadAll(app) {
        this.app = app; // Store for signer access in getStorage
        const discovered = this.discover();

        for (const agentInfo of discovered) {
            try {
                await this.loadAgent(agentInfo, app);
            } catch (error) {
                console.error(`Failed to load agent ${agentInfo.name}:`, error);
            }
        }

        console.log(`Loaded ${this.agents.size} agent module(s)`);
    }

    /**
     * Load a single agent module
     */
    async loadAgent(agentInfo, app) {
        const { name, manifest, entryPath } = agentInfo;

        if (!manifest.name) {
            console.error(`Agent ${name} missing name in epistery.json, skipping`);
            return;
        }

        // Derive route path from npm package name (remove @ for URL safety)
        const routeName = manifest.name.replace(/^@/, '');

        // Build the agent's router
        const agentRouter = await this.buildAgentRouter(agentInfo);

        // Agent data with mutable router reference for hot-reload
        const agentData = {
            agentInfo,
            manifest,
            instance: agentRouter._agentInstance,
            activeRouter: agentRouter,
            wellKnownPath: `/.well-known/epistery/agent/${routeName}`,
            shortPath: `/agent/${routeName}`
        };

        // Mount a proxy that delegates to the current activeRouter.
        // This never changes - on reload we just swap activeRouter.
        const proxy = (req, res, next) => agentData.activeRouter(req, res, next);

        // If agent has a .git directory, mount /_update before the proxy
        const gitDir = join(agentInfo.path, '.git');
        if (existsSync(gitDir)) {
            const updateRouter = express.Router();
            updateRouter.get('/_update', async (req, res) => {
                try {
                    if (!req.domainAcl || !await req.domainAcl.isAdmin(req.episteryClient?.identityAddress)) {
                        return res.status(403).json({success: false, error: 'Not authorized'});
                    }
                    await this.updateAgent(agentInfo.path, manifest.branch || 'main');
                    await this.reloadAgent(name);
                    res.json({success: true, message: `${manifest.name} updated and reloaded`});
                } catch (error) {
                    res.status(500).json({success: false, error: error.message});
                }
            });
            app.use(agentData.wellKnownPath, updateRouter);
            app.use(agentData.shortPath, updateRouter);
        }

        app.use(agentData.wellKnownPath, proxy);
        app.use(agentData.shortPath, proxy);

        console.log(`Agent ${manifest.name} v${manifest.version} mounted at:`);
        console.log(`  - ${agentData.wellKnownPath}/*`);
        console.log(`  - ${agentData.shortPath}/*`);

        this.agents.set(name, agentData);
        this._rebuildToolRegistry();
    }

    /**
     * Build a fresh router for an agent module
     */
    async buildAgentRouter(agentInfo) {
        const { name, manifest, entryPath } = agentInfo;

        // Cache-bust on reload so Node reimports the module.
        // Skip on first load so debugger breakpoints work (clean file URL).
        agentInfo._loadCount = (agentInfo._loadCount || 0) + 1;
        const moduleUrl = agentInfo._loadCount > 1
            ? pathToFileURL(entryPath).href + `?t=${Date.now()}`
            : pathToFileURL(entryPath).href;
        const AgentClass = (await import(moduleUrl)).default;
        const agentInstance = new AgentClass({
            ...manifest.config,
            getStorage: (domain, agentName) => StorageFactory.create(null, domain, agentName, this.app?.locals?.epistery?.signer),
            getAgentTools: () => this.getRegisteredTools(),
            callBridgedTool: (peerId, toolName, args) => this.callBridgedTool(peerId, toolName, args),
            _agentManager: this,
            // Host services — agents MUST NOT use relative imports to reach host internals.
            // Everything an agent needs from the host is injected here.
            host: {
                keyManager,
                crypto: { MasterKey, ECDH, PACKAGE_TYPES, VERSIONS },
                storage: { StorageFactory, EncryptedStorage },
                contractArtifact: this.contractArtifact
            }
        });

        const agentRouter = express.Router();

        // Agents live under ~/.epistery/.agents/ — both directories start with '.'
        // Express's send module rejects sendFile through dotfile paths by default.
        // Patch res.sendFile on agent routes to allow dotfile paths.
        agentRouter.use((req, res, next) => {
            const _sendFile = res.sendFile.bind(res);
            res.sendFile = function(filePath, options, fn) {
                if (typeof options === 'function') { fn = options; options = {}; }
                return _sendFile(filePath, { dotfiles: 'allow', ...options }, fn);
            };
            next();
        });

        if (typeof agentInstance.attach === 'function') {
            agentInstance.attach(agentRouter);
        } else {
            console.warn(`Agent ${name} has no attach() method`);
        }

        // Stash instance on router so we can clean it up later
        agentRouter._agentInstance = agentInstance;
        return agentRouter;
    }

    /**
     * Hot-reload an agent: cleanup old instance, build new router, swap in
     */
    async reloadAgent(name) {
        const agentData = this.agents.get(name);
        if (!agentData) throw new Error(`Agent ${name} not found`);

        // Cleanup old instance
        if (typeof agentData.instance.cleanup === 'function') {
            await agentData.instance.cleanup();
        }

        // Re-read manifest (it may have changed)
        const manifestPath = join(agentData.agentInfo.path, 'epistery.json');
        agentData.agentInfo.manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        agentData.manifest = agentData.agentInfo.manifest;

        // Build new router and swap it in
        const newRouter = await this.buildAgentRouter(agentData.agentInfo);
        agentData.activeRouter = newRouter;
        agentData.instance = newRouter._agentInstance;

        // Re-attach WebSocket servers to the fresh instance. initializeWebSockets
        // only runs at boot, so without this a reloaded agent loses its live
        // sockets (cleanup() above already closed the old instance's servers).
        if (typeof agentData.instance.initWebSocket === 'function' && this.wsServers) {
            for (const server of this.wsServers) {
                try {
                    agentData.instance.initWebSocket(server);
                } catch (error) {
                    console.error(`[AgentManager] WebSocket re-init failed for ${name}:`, error.message);
                }
            }
        }

        this._rebuildToolRegistry();
        console.log(`[AgentManager] Reloaded ${agentData.manifest.name}`);
    }

    /**
     * Rebuild the tool registry from all loaded agent manifests.
     * Each tool entry gets the agent's base path so callers can proxy generically.
     */
    _rebuildToolRegistry() {
        const tools = [];
        for (const [, agentData] of this.agents) {
            const { manifest, shortPath } = agentData;
            if (!Array.isArray(manifest.tools)) continue;
            for (const tool of manifest.tools) {
                tools.push({
                    name: tool.name,
                    description: tool.description,
                    method: (tool.method || 'GET').toUpperCase(),
                    basePath: shortPath,
                    path: tool.path,
                    inputSchema: tool.inputSchema || { type: 'object', properties: {} }
                });
            }
        }
        this.toolRegistry = tools;
        if (tools.length) {
            console.log(`[AgentManager] Tool registry: ${tools.length} tool(s) from ${new Set(tools.map(t => t.basePath)).size} agent(s)`);
        }
    }

    /**
     * Register tools from a bridge peer as external tools.
     * Each tool gets bridged:true and peerId so callers route through PeerBridge.
     */
    registerExternalTools(tools, peerId) {
        this.externalTools.set(peerId, tools.map(t => ({
            ...t,
            bridged: true,
            peerId
        })));
        console.log(`[AgentManager] Registered ${tools.length} external tool(s) from peer ${peerId}`);
    }

    /**
     * Remove external tools when a bridge peer disconnects.
     */
    unregisterExternalTools(peerId) {
        if (this.externalTools.delete(peerId)) {
            console.log(`[AgentManager] Unregistered external tools from peer ${peerId}`);
        }
    }

    /**
     * Return all registered agent tools (local + bridged).
     * Called by agents (e.g. Mimi) via the getAgentTools config function.
     */
    getRegisteredTools() {
        const all = [...this.toolRegistry];
        for (const tools of this.externalTools.values()) {
            all.push(...tools);
        }
        return all;
    }

    /**
     * Call a tool on a bridged peer via PeerBridge.
     * Set by index.mjs after PeerBridge is created.
     */
    callBridgedTool(peerId, toolName, args) {
        if (!this.peerBridge) {
            return Promise.reject(new Error('PeerBridge not initialized'));
        }
        return this.peerBridge.callRemoteTool(peerId, toolName, args);
    }

    initializeWebSockets(server) {
        // Remember the HTTP server(s) (called once per http/https server at boot)
        // so a hot-reloaded agent instance can re-attach its WebSocket — otherwise
        // reloadAgent() builds a fresh instance whose wss is null and live updates
        // silently die until a full process restart.
        if (!this.wsServers) this.wsServers = [];
        if (!this.wsServers.includes(server)) this.wsServers.push(server);

        for (const [name, { instance }] of this.agents) {
            if (typeof instance.initWebSocket === 'function') {
                try {
                    instance.initWebSocket(server);
                    console.log(`Agent ${name} WebSocket initialized`);
                } catch (error) {
                    console.error(`Error initializing WebSocket for agent ${name}:`, error);
                }
            }
        }
    }

    /**
     * Pull latest code for an agent and install dependencies.
     * Remote is whatever .git/config says - no URL override.
     */
    /**
     * The clone's `origin`, with any embedded credentials removed.
     *
     * `git clone https://x-access-token:TOKEN@host/org/repo` persists that URL —
     * token and all — into .git/config. That is how credentials went stale here:
     * rotating a PAT left every existing clone fetching with the old one, and
     * `git fetch` exits 128 with no hint that the token is the problem.
     *
     * Returns { url, host, org } for the credential-free URL, or null for a
     * non-HTTP remote (ssh), which carries no credentials to refresh.
     */
    async gitOrigin(agentPath) {
        const raw = await this.captureCommand('git', ['remote', 'get-url', 'origin'], agentPath);
        if (!raw) return null;
        let url;
        try {
            url = new URL(raw.trim());
        } catch {
            return null;                       // scp-style ssh remote (git@host:org/repo)
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        url.username = '';
        url.password = '';
        const org = url.pathname.split('/').filter(Boolean)[0] || null;
        return { url: url.toString(), host: url.hostname, org };
    }

    /**
     * Update a managed agent checkout.
     *
     * Credentials are re-derived from config on every fetch rather than read
     * back out of .git/config. Two consequences, both wanted: rotating a PAT
     * takes effect immediately instead of silently breaking update for that
     * org's plugins, and the secret is scrubbed from .git/config rather than
     * living on disk in every clone.
     *
     * The token reaches git through a credential helper that reads it from the
     * environment, so it appears in neither the process arguments (visible to
     * any user via `ps`) nor the repository config.
     */
    async updateAgent(agentPath, branch) {
        console.log(`[AgentManager] Updating ${agentPath} on branch ${branch}`);

        const args = ['fetch', 'origin', branch];
        const env = {};
        const origin = await this.gitOrigin(agentPath);

        if (origin) {
            // Persist the credential-free URL; any stale embedded token is gone
            // for good, not just bypassed for this fetch.
            await this.executeCommand('git', ['remote', 'set-url', 'origin', origin.url], agentPath);

            const token = this.gitAuth ? await this.gitAuth(origin.host, origin.org) : null;
            if (token) {
                const cred = gitCredential(token);
                Object.assign(env, cred.env);
                args.unshift(...cred.args);
            } else if (origin.org) {
                console.warn(`[AgentManager] No git credential configured for ${origin.host}/${origin.org} — fetching unauthenticated.`);
            }
        }

        await this.executeCommand('git', args, agentPath, env);
        await this.executeCommand('git', ['reset', '--hard', `origin/${branch}`], agentPath);
        await this.executeCommand('npm', ['install', '--no-audit', '--no-fund'], agentPath);
        console.log(`[AgentManager] Update complete for ${agentPath}`);
    }

    /** Run a command and return its stdout, or null if it fails. */
    captureCommand(command, args, cwd) {
        return new Promise((resolve) => {
            const child = spawn(command, args, {
                stdio: ['ignore', 'pipe', 'inherit'],
                cwd,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
            });
            let out = '';
            child.stdout.on('data', (d) => { out += d; });
            child.on('close', (code) => resolve(code === 0 ? out : null));
            child.on('error', () => resolve(null));
        });
    }

    executeCommand(command, args, cwd, extraEnv = {}) {
        return new Promise((resolve, reject) => {
            console.log(`[AgentManager] ${cwd}: ${command} ${args.join(' ')}`);
            const child = spawn(command, args, {
                stdio: ['ignore', 'inherit', 'inherit'],
                cwd,
                // Never let git block on an interactive credential prompt — stdin
                // is closed, so a prompt would hang the host forever. Missing/expired
                // credentials must fail fast with a non-zero exit, not stall.
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...extraEnv }
            });
            child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`"${command} ${args.join(' ')}" exited ${code}`));
            });
            child.on('error', reject);
        });
    }

    /**
     * Load a single agent from its .agents/ folder into the running system.
     * Identity is taken from epistery.json — the folder is just the location.
     * Returns the canonical agent name. Used to hot-load a freshly cloned or
     * newly symlinked plugin.
     */
    async loadAgentFromDir(dir) {
        const agentDir = join(this.agentsPath, dir);
        const manifestPath = join(agentDir, 'epistery.json');
        const entryPath = join(agentDir, 'index.mjs');

        if (!existsSync(manifestPath)) throw new Error(`${dir} missing epistery.json`);
        if (!existsSync(entryPath)) throw new Error(`${dir} missing index.mjs`);

        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!manifest.name) throw new Error(`${dir}/epistery.json has no name`);

        const agentInfo = { name: normalizeAgentName(manifest.name), path: agentDir, manifest, entryPath };
        await this.loadAgent(agentInfo, this.app);
        return agentInfo.name;
    }

    /**
     * Unload a running agent: cleanup instance, remove from agents Map,
     * and rebuild tool registry. Used by PluginManager on plugin removal.
     */
    async unloadAgent(name) {
        const agentData = this.agents.get(name);
        if (!agentData) throw new Error(`Agent ${name} not loaded`);

        if (typeof agentData.instance.cleanup === 'function') {
            await agentData.instance.cleanup();
        }

        this.agents.delete(name);
        this._rebuildToolRegistry();
        console.log(`[AgentManager] Unloaded ${name}`);
    }

    /**
     * Cleanup all agents on shutdown
     */
    async cleanup() {
        for (const [name, { instance }] of this.agents) {
            if (typeof instance.cleanup === 'function') {
                try {
                    await instance.cleanup();
                    console.log(`Agent ${name} cleaned up`);
                } catch (error) {
                    console.error(`Error cleaning up agent ${name}:`, error);
                }
            }
        }
    }
}
