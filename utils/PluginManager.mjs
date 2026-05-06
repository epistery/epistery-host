/**
 * PluginManager — Managed plugin installation for epistery-host.
 *
 * Mounts directly in index.mjs via PluginManager.attach(app), same pattern
 * as OAuthServer and MCPServer.
 *
 * Provides:
 *   - Filesystem-based agent discovery (scans ~/.epistery/.agents/)
 *   - Plugin install (git clone + npm install + hot-load)
 *   - Plugin update (git fetch/reset + npm install + hot-reload)
 *   - Plugin remove (cleanup + rm -rf)
 *   - Tracking via .installed.json for managed plugin metadata
 *   - Multi-source registry configuration via root config.ini
 *
 * Agent types discovered by installed():
 *   - linked: symlinks (developer-managed, not updatable/removable)
 *   - managed: directories tracked in .installed.json (installed by PluginManager)
 *   - local: directories not in tracking (manually placed)
 *
 * All API endpoints are admin-gated.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, readlinkSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import { Config } from 'epistery';

export class PluginManager {

    static attach(app) {
        const self = PluginManager;

        // Resolve paths from Config
        const cfg = new Config();
        self._agentsDir = join(cfg.configDir, '.agents');
        self._trackingPath = join(self._agentsDir, '.installed.json');
        self._app = app;

        console.log(`[PluginManager] Tracking file: ${self._trackingPath}`);

        // ── Admin gate middleware for all plugin routes ──
        const adminGate = async (req, res, next) => {
            const isAdmin = await req.domainAcl?.isAdmin(req.episteryClient?.address);
            if (!isAdmin) return res.status(403).json({ error: 'Not authorized' });
            next();
        };

        // ── GET /api/plugins/installed ──
        app.get('/api/plugins/installed', adminGate, (req, res) => {
            res.json({ agents: self.installed() });
        });

        // ── GET /api/plugins/sources ──
        app.get('/api/plugins/sources', adminGate, (req, res) => {
            res.json({ sources: self.sources() });
        });

        // ── POST /api/plugins/install ──
        app.post('/api/plugins/install', adminGate, async (req, res) => {
            try {
                const { name, repository, branch } = req.body;
                if (!name || !repository) {
                    return res.status(400).json({ error: 'name and repository are required' });
                }
                await self.install(name, repository, branch || 'main');
                res.json({ success: true, message: `${name} installed` });
            } catch (error) {
                console.error('[PluginManager] Install error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // ── POST /api/plugins/update ──
        app.post('/api/plugins/update', adminGate, async (req, res) => {
            try {
                const { name } = req.body;
                if (!name) return res.status(400).json({ error: 'name is required' });
                await self.update(name);
                res.json({ success: true, message: `${name} updated` });
            } catch (error) {
                console.error('[PluginManager] Update error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // ── POST /api/plugins/remove ──
        app.post('/api/plugins/remove', adminGate, async (req, res) => {
            try {
                const { name } = req.body;
                if (!name) return res.status(400).json({ error: 'name is required' });
                await self.remove(name);
                res.json({ success: true, message: `${name} removed` });
            } catch (error) {
                console.error('[PluginManager] Remove error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        // ── POST /api/plugins/check-updates ──
        app.post('/api/plugins/check-updates', adminGate, async (req, res) => {
            try {
                const { name } = req.body;
                const results = await self.checkUpdates(name || null);
                res.json({ updates: results });
            } catch (error) {
                console.error('[PluginManager] Check-updates error:', error);
                res.status(500).json({ error: error.message });
            }
        });

        console.log('[PluginManager] API routes mounted');
    }

    /**
     * Install a plugin: git clone + npm install + hot-load into AgentManager.
     */
    static async install(name, repository, branch = 'main') {
        const self = PluginManager;
        const dirName = self._dirName(name);
        const targetDir = join(self._agentsDir, dirName);
        const agentManager = self._app.locals.agentManager;

        // Conflict check: refuse if directory exists and isn't managed by us
        if (existsSync(targetDir)) {
            const tracking = self._readTracking();
            if (!tracking.plugins?.[dirName]) {
                throw new Error(`${dirName} already exists in .agents/ (symlink or manual install). Remove it first.`);
            }
            throw new Error(`${name} is already installed. Use update instead.`);
        }

        console.log(`[PluginManager] Installing ${name} from ${repository} (${branch})`);

        // Clone — inject PAT if configured, log only the public URL
        const authRepo = self._authUrl(repository);
        if (authRepo === repository && repository.includes('github.com')) {
            const org = new URL(repository).pathname.split('/').filter(Boolean)[0];
            console.warn(`[PluginManager] No GitHub PAT for org "${org}". If repo is private, add [plugins.github] ${org}=ghp_xxx to ~/.epistery/config.ini`);
        }
        try {
            await self._exec(
                'git', ['clone', '--branch', branch, '--single-branch', authRepo, targetDir],
                self._agentsDir,
                `git clone --branch ${branch} --single-branch ${repository} ${targetDir}`
            );
        } catch (err) {
            if (authRepo === repository && repository.includes('github.com')) {
                throw new Error(`Clone failed for ${name}. If the repo is private, configure a GitHub PAT: [plugins.github] in ~/.epistery/config.ini. Original error: ${err.message}`);
            }
            throw err;
        }

        // npm install
        await agentManager.executeCommand(
            'npm', ['install', '--no-audit', '--no-fund'],
            targetDir
        );

        // Validate required files
        const manifestPath = join(targetDir, 'epistery.json');
        const entryPath = join(targetDir, 'index.mjs');
        if (!existsSync(manifestPath) || !existsSync(entryPath)) {
            // Cleanup failed install
            rmSync(targetDir, { recursive: true, force: true });
            throw new Error(`${name} is missing epistery.json or index.mjs — not a valid plugin`);
        }

        // Read manifest for version info
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

        // Track
        const tracking = self._readTracking();
        tracking.plugins[dirName] = {
            name,
            repository,
            branch,
            installedVersion: manifest.version || '0.0.0',
            installedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString()
        };
        self._writeTracking(tracking);

        // Hot-load into running system
        await agentManager.loadAgentByName(dirName);

        console.log(`[PluginManager] ${name} installed and loaded`);
    }

    /**
     * Update an installed plugin: git fetch/reset + npm install + hot-reload.
     */
    static async update(name) {
        const self = PluginManager;
        const dirName = self._dirName(name);
        const tracking = self._readTracking();
        const record = tracking.plugins?.[dirName];

        if (!record) {
            throw new Error(`${name} is not a managed plugin — only PluginManager-installed agents can be updated`);
        }

        const agentManager = self._app.locals.agentManager;
        const targetDir = join(self._agentsDir, dirName);
        const branch = record.branch || 'main';

        console.log(`[PluginManager] Updating ${name} on branch ${branch}`);

        // Use AgentManager's existing updateAgent method
        await agentManager.updateAgent(targetDir, branch);

        // Re-read manifest for version info
        const manifestPath = join(targetDir, 'epistery.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

        // Hot-reload
        await agentManager.reloadAgent(dirName);

        // Update tracking
        record.installedVersion = manifest.version || record.installedVersion;
        record.lastUpdated = new Date().toISOString();
        self._writeTracking(tracking);

        console.log(`[PluginManager] ${name} updated and reloaded`);
    }

    /**
     * Remove an installed plugin: cleanup + rm -rf + remove from tracking.
     */
    static async remove(name) {
        const self = PluginManager;
        const dirName = self._dirName(name);
        const tracking = self._readTracking();
        const record = tracking.plugins?.[dirName];

        if (!record) {
            throw new Error(`${name} is not a managed plugin — only PluginManager-installed agents can be removed`);
        }

        const agentManager = self._app.locals.agentManager;
        const targetDir = join(self._agentsDir, dirName);

        console.log(`[PluginManager] Removing ${name}`);

        // Unload from running system
        try {
            await agentManager.unloadAgent(dirName);
        } catch (err) {
            console.warn(`[PluginManager] Unload warning: ${err.message}`);
        }

        // Delete directory
        rmSync(targetDir, { recursive: true, force: true });

        // Remove from tracking
        delete tracking.plugins[dirName];
        self._writeTracking(tracking);

        console.log(`[PluginManager] ${name} removed`);
    }

    /**
     * Check for updates by comparing local HEAD against remote.
     * If name is null, checks all managed plugins.
     */
    static async checkUpdates(name) {
        const self = PluginManager;
        const tracking = self._readTracking();
        const agentManager = self._app.locals.agentManager;
        const results = [];

        const targets = name
            ? { [self._dirName(name)]: tracking.plugins?.[self._dirName(name)] }
            : tracking.plugins;

        for (const [dirName, record] of Object.entries(targets)) {
            if (!record) continue;
            const targetDir = join(self._agentsDir, dirName);
            if (!existsSync(targetDir)) continue;

            try {
                const branch = record.branch || 'main';
                await agentManager.executeCommand('git', ['fetch', 'origin', branch], targetDir);

                // Compare local HEAD vs remote HEAD
                const localHead = await self._gitRev(targetDir, 'HEAD');
                const remoteHead = await self._gitRev(targetDir, `origin/${branch}`);

                results.push({
                    name: record.name,
                    dirName,
                    hasUpdate: localHead !== remoteHead,
                    localHead: localHead?.slice(0, 8),
                    remoteHead: remoteHead?.slice(0, 8),
                    installedVersion: record.installedVersion
                });
            } catch (err) {
                results.push({
                    name: record.name,
                    dirName,
                    hasUpdate: false,
                    error: err.message
                });
            }
        }

        return results;
    }

    /**
     * Scan .agents/ directory to discover all installed agents.
     * Returns object keyed by directory name with type: linked|managed|local.
     */
    static installed() {
        const self = PluginManager;
        const agents = {};

        let entries;
        try {
            entries = readdirSync(self._agentsDir, { withFileTypes: true });
        } catch {
            return agents;
        }

        const tracking = self._readTracking();

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const agentDir = join(self._agentsDir, entry.name);
            const stat = lstatSync(agentDir);

            if (stat.isSymbolicLink()) {
                const manifest = self._readManifest(agentDir);
                if (!manifest) continue;
                agents[entry.name] = {
                    name: manifest.name || entry.name,
                    version: manifest.version || '0.0.0',
                    type: 'linked',
                    target: readlinkSync(agentDir)
                };
            } else if (stat.isDirectory()) {
                const manifest = self._readManifest(agentDir);
                if (!manifest) continue;
                const record = tracking.plugins?.[entry.name];
                if (record) {
                    agents[entry.name] = {
                        ...record,
                        version: manifest.version || record.installedVersion,
                        type: 'managed'
                    };
                } else {
                    agents[entry.name] = {
                        name: manifest.name || entry.name,
                        version: manifest.version || '0.0.0',
                        type: 'local'
                    };
                }
            }
        }

        return agents;
    }

    /**
     * Read epistery.json manifest from an agent directory.
     */
    static _readManifest(dir) {
        try {
            return JSON.parse(readFileSync(join(dir, 'epistery.json'), 'utf8'));
        } catch {
            return null;
        }
    }

    /**
     * Read .installed.json tracking file (internal).
     */
    static _readTracking() {
        const self = PluginManager;
        try {
            return JSON.parse(readFileSync(self._trackingPath, 'utf8'));
        } catch {
            return { version: 1, plugins: {} };
        }
    }

    /**
     * Write .installed.json tracking file.
     */
    static _writeTracking(data) {
        const self = PluginManager;
        writeFileSync(self._trackingPath, JSON.stringify(data, null, 2));
    }

    /**
     * Read registry source URLs from root config.
     * Configured in ~/.epistery/config.ini as [plugins] registry=url1,url2
     */
    static sources() {
        const self = PluginManager;
        const DEFAULT_REGISTRY = 'https://epistery.host/agent/epistery/registry/api/plugins';
        try {
            const cfg = new Config();
            const rootData = cfg.read('/');
            const raw = rootData?.plugins?.registry || DEFAULT_REGISTRY;
            return raw.split(',').map(s => s.trim()).filter(Boolean);
        } catch {
            return [DEFAULT_REGISTRY];
        }
    }

    /**
     * Derive directory name from package name.
     * "@epistery/wiki" → "wiki", "@geistm/adnet-agent" → "adnet-agent"
     */
    static _dirName(name) {
        return name.split('/').pop();
    }

    /**
     * Get git revision hash for a ref.
     */
    static async _gitRev(cwd, ref) {
        return new Promise((resolve, reject) => {
            const child = spawn('git', ['rev-parse', ref], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            child.stdout.on('data', d => out += d);
            child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`git rev-parse failed (${code})`)));
            child.on('error', reject);
        });
    }

    /**
     * Run a command with token-safe logging.
     * safeLog replaces the command in log/error output so PATs never leak.
     */
    static _exec(command, args, cwd, safeLog) {
        return new Promise((resolve, reject) => {
            const logStr = safeLog || `${command} ${args.join(' ')}`;
            console.log(`[PluginManager] ${logStr}`);
            const child = spawn(command, args, {
                stdio: ['ignore', 'inherit', 'inherit'],
                cwd
            });
            child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`"${logStr}" exited ${code}`));
            });
            child.on('error', reject);
        });
    }

    /**
     * Inject a GitHub PAT into a repository URL if one is configured.
     *
     * Config in ~/.epistery/config.ini:
     *   [plugins.github]
     *   rootz-global=ghp_xxxxxxxxxxxx
     *   epistery=ghp_yyyyyyyyyyyy
     *
     * Parsed as: plugins.github['rootz-global'], plugins.github.epistery
     *
     * Returns the original URL unchanged for non-GitHub repos or if no PAT is found.
     */
    static _authUrl(repository) {
        try {
            const url = new URL(repository);
            if (url.hostname !== 'github.com') return repository;

            const org = url.pathname.split('/').filter(Boolean)[0];
            if (!org) return repository;

            const cfg = new Config();
            const rootData = cfg.read('/');
            const token = rootData?.plugins?.github?.[org];
            if (!token) return repository;

            url.username = 'x-access-token';
            url.password = token;
            return url.toString();
        } catch {
            return repository;
        }
    }
}
