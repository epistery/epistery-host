import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import express from 'express';

/**
 * AgentManager - Discovers and loads epistery agent modules
 *
 * Agent modules are located in ~/.epistery/.agents/
 * Each agent has an epistery.json manifest describing its capabilities
 * Agents are automatically namespaced under /.well-known/epistery/agent/{agentName}/*
 */
export class AgentManager {
    constructor(agentsPath) {
        this.agentsPath = agentsPath;
        this.agents = new Map();
        this.baseRoute = '/.well-known/epistery/agent';
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

        if (!manifest.agentName) {
            console.error(`Agent ${name} missing agentName in epistery.json, skipping`);
            return;
        }

        // Import the agent module
        const moduleUrl = pathToFileURL(entryPath).href;
        const AgentClass = (await import(moduleUrl)).default;

        // Instantiate with config from manifest
        const agentInstance = new AgentClass(manifest.config || {});

        // Create a namespaced router for this agent
        const agentRouter = express.Router();
        const agentBasePath = `${this.baseRoute}/${manifest.agentName}`;

        // Attach agent to its namespaced router
        if (typeof agentInstance.attach === 'function') {
            agentInstance.attach(agentRouter);
            console.log(`Agent ${manifest.name} attached to ${agentBasePath}/*`);
        } else {
            console.warn(`Agent ${name} has no attach() method`);
        }

        // Mount the agent's router at its namespaced path
        app.use(agentBasePath, agentRouter);

        // Store reference
        this.agents.set(name, {
            manifest,
            instance: agentInstance,
            basePath: agentBasePath
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
