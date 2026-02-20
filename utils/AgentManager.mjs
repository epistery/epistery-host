import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { spawn } from 'child_process';
import express from 'express';

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
 */
export class AgentManager {
    constructor(agentsPath) {
        this.agentsPath = agentsPath;
        this.agents = new Map();
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
                let result = readFileSync(manifestPath, 'utf8');
                const manifest = JSON.parse(result);
                discovered.push({
                    name: entry.name,
                    path: agentDir,
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
                    if (!req.domainAcl || !await req.domainAcl.isAdmin(req.episteryClient?.address)) {
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
    }

    /**
     * Build a fresh router for an agent module
     */
    async buildAgentRouter(agentInfo) {
        const { name, manifest, entryPath } = agentInfo;

        // Cache-bust: append timestamp so Node reimports the module
        const moduleUrl = pathToFileURL(entryPath).href + `?t=${Date.now()}`;
        const AgentClass = (await import(moduleUrl)).default;
        const agentInstance = new AgentClass(manifest.config || {});

        const agentRouter = express.Router();
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

        console.log(`[AgentManager] Reloaded ${agentData.manifest.name}`);
    }

    initializeWebSockets(server) {
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
    async updateAgent(agentPath, branch) {
        console.log(`[AgentManager] Updating ${agentPath} on branch ${branch}`);
        await this.executeCommand('git', ['fetch', 'origin', branch], agentPath);
        await this.executeCommand('git', ['reset', '--hard', `origin/${branch}`], agentPath);
        await this.executeCommand('npm', ['install', '--no-audit', '--no-fund'], agentPath);
        console.log(`[AgentManager] Update complete for ${agentPath}`);
    }

    executeCommand(command, args, cwd) {
        return new Promise((resolve, reject) => {
            console.log(`[AgentManager] ${cwd}: ${command} ${args.join(' ')}`);
            const child = spawn(command, args, {
                stdio: ['ignore', 'inherit', 'inherit'],
                cwd
            });
            child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`"${command} ${args.join(' ')}" exited ${code}`));
            });
            child.on('error', reject);
        });
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
