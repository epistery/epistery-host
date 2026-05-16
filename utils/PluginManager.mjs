/**
 * PluginManager — managed plugin installation for epistery-host.
 *
 * Mounts directly in index.mjs via PluginManager.attach(app), same pattern
 * as OAuthServer and MCPServer.
 *
 * Provides:
 *   - Filesystem-based agent discovery (scans ~/.epistery/.agents/)
 *   - Plugin install (git clone + npm install + hot-load)
 *   - Plugin update (git fetch/reset + npm install + hot-reload)
 *   - Plugin remove (cleanup + rm -rf)
 *   - Multi-source registry configuration via root config.ini
 *
 * Single source of truth: the filesystem.
 *
 *   - Symlink in .agents/X  → type: 'linked'  (developer-managed; can't be
 *     updated or removed from the UI — the symlink target lives outside .agents/).
 *   - Directory in .agents/X → type: 'managed' (installed via this manager
 *     OR cloned by hand — same treatment either way; the .git directory IS the
 *     metadata: remote URL, branch, and HEAD all derived on demand).
 *
 * No .installed.json. No parallel state to drift.
 */

import { existsSync, readFileSync, rmSync, readdirSync, lstatSync, readlinkSync } from 'fs';
import { join } from 'path';
import { spawn, spawnSync } from 'child_process';
import { Config } from 'epistery';

export class PluginManager {

    static attach(app) {
        const self = PluginManager;

        const cfg = new Config();
        self._agentsDir = join(cfg.configDir, '.agents');
        self._app = app;

        // Legacy: deprecated tracking file is no longer consulted. Flag once
        // at startup so an operator knows it's safe to delete.
        const legacy = join(self._agentsDir, '.installed.json');
        if (existsSync(legacy)) {
            console.warn(
                `[PluginManager] ${legacy} is no longer consulted (filesystem is the only source of truth). ` +
                `You can delete it: rm ${legacy}`
            );
        }

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

        if (existsSync(targetDir)) {
            throw new Error(`${dirName} already exists in .agents/. Remove it first (or use update).`);
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

        await agentManager.executeCommand(
            'npm', ['install', '--no-audit', '--no-fund'],
            targetDir
        );

        const manifestPath = join(targetDir, 'epistery.json');
        const entryPath = join(targetDir, 'index.mjs');
        if (!existsSync(manifestPath) || !existsSync(entryPath)) {
            rmSync(targetDir, { recursive: true, force: true });
            throw new Error(`${name} is missing epistery.json or index.mjs — not a valid plugin`);
        }

        await agentManager.loadAgentByName(dirName);

        console.log(`[PluginManager] ${name} installed and loaded`);
    }

    /**
     * Update an installed plugin: git fetch/reset + npm install + hot-reload.
     * Refuses symlinks — their target is managed outside .agents/.
     */
    static async update(name) {
        const self = PluginManager;
        const dirName = self._dirName(name);
        const targetDir = join(self._agentsDir, dirName);

        if (!existsSync(targetDir)) {
            throw new Error(`${name} is not installed`);
        }
        if (lstatSync(targetDir).isSymbolicLink()) {
            throw new Error(`${name} is a symlink (linked plugin). Update its source manually.`);
        }

        const branch = self._gitBranch(targetDir) || 'main';
        const agentManager = self._app.locals.agentManager;

        console.log(`[PluginManager] Updating ${name} on branch ${branch}`);

        await agentManager.updateAgent(targetDir, branch);
        await agentManager.reloadAgent(dirName);

        console.log(`[PluginManager] ${name} updated and reloaded`);
    }

    /**
     * Remove an installed plugin: unload + rm -rf.
     * Refuses symlinks — operator should remove the symlink by hand if intentional.
     */
    static async remove(name) {
        const self = PluginManager;
        const dirName = self._dirName(name);
        const targetDir = join(self._agentsDir, dirName);

        if (!existsSync(targetDir)) {
            throw new Error(`${name} is not installed`);
        }
        if (lstatSync(targetDir).isSymbolicLink()) {
            throw new Error(
                `${name} is a symlink (linked plugin). Remove it by hand: rm ${targetDir}`
            );
        }

        const agentManager = self._app.locals.agentManager;

        console.log(`[PluginManager] Removing ${name}`);

        try {
            await agentManager.unloadAgent(dirName);
        } catch (err) {
            console.warn(`[PluginManager] Unload warning: ${err.message}`);
        }

        rmSync(targetDir, { recursive: true, force: true });

        console.log(`[PluginManager] ${name} removed`);
    }

    /**
     * Check for updates by comparing local HEAD against remote.
     * Walks .agents/ — managed (directory) plugins only; symlinks skipped.
     * If name is null, checks every managed plugin.
     */
    static async checkUpdates(name) {
        const self = PluginManager;
        const agentManager = self._app.locals.agentManager;
        const allInstalled = self.installed();
        const targets = name
            ? { [self._dirName(name)]: allInstalled[self._dirName(name)] }
            : allInstalled;

        const results = [];
        for (const [dirName, info] of Object.entries(targets)) {
            if (!info || info.type !== 'managed') continue;
            const targetDir = join(self._agentsDir, dirName);

            try {
                const branch = info.branch || 'main';
                await agentManager.executeCommand('git', ['fetch', 'origin', branch], targetDir);

                const localHead = await self._gitRevAsync(targetDir, 'HEAD');
                const remoteHead = await self._gitRevAsync(targetDir, `origin/${branch}`);

                results.push({
                    name: info.name,
                    dirName,
                    hasUpdate: localHead !== remoteHead,
                    localHead: localHead?.slice(0, 8),
                    remoteHead: remoteHead?.slice(0, 8),
                    installedVersion: info.version
                });
            } catch (err) {
                results.push({
                    name: info.name,
                    dirName,
                    hasUpdate: false,
                    error: err.message
                });
            }
        }

        return results;
    }

    /**
     * Scan .agents/ to discover all installed agents. Filesystem is the only
     * source of truth — directories are managed, symlinks are linked.
     * `repository`, `branch`, and `installedAt` are derived on demand from
     * the .git directory and filesystem stat.
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

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            const agentDir = join(self._agentsDir, entry.name);
            const stat = lstatSync(agentDir);

            const manifest = self._readManifest(agentDir);
            if (!manifest) continue;

            const pkg = self._readPackageJson(agentDir);
            const baseInfo = {
                name: manifest.name || entry.name,
                version: pkg?.version || manifest.version || '0.0.0',
            };

            if (stat.isSymbolicLink()) {
                agents[entry.name] = {
                    ...baseInfo,
                    type: 'linked',
                    target: readlinkSync(agentDir),
                };
            } else if (stat.isDirectory()) {
                agents[entry.name] = {
                    ...baseInfo,
                    type: 'managed',
                    repository: self._gitOrigin(agentDir),
                    branch: self._gitBranch(agentDir),
                    installedAt: self._installedAt(agentDir),
                };
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

    static _readPackageJson(dir) {
        try {
            return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        } catch {
            return null;
        }
    }

    /**
     * Read registry source URLs from root config.
     * Configured in ~/.epistery/config.ini as [plugins] registry=url1,url2
     */
    static sources() {
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

    // ── git helpers ────────────────────────────────────────────────────────

    /**
     * Sync helper: run git with args in cwd, return trimmed stdout or null
     * on any failure. Used by installed() which must stay synchronous.
     */
    static _gitInfoSync(cwd, args) {
        try {
            const out = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
            return out.status === 0 ? out.stdout.trim() : null;
        } catch {
            return null;
        }
    }

    /**
     * Origin URL with any embedded PAT scrubbed out. Returns null if no
     * origin is configured (e.g. directory isn't a git repo).
     */
    static _gitOrigin(dir) {
        const raw = PluginManager._gitInfoSync(dir, ['remote', 'get-url', 'origin']);
        if (!raw) return null;
        try {
            const u = new URL(raw);
            if (u.username || u.password) {
                u.username = '';
                u.password = '';
                return u.toString();
            }
            return raw;
        } catch {
            return raw;
        }
    }

    /**
     * Current branch name, or null if detached/unknown.
     */
    static _gitBranch(dir) {
        const out = PluginManager._gitInfoSync(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
        return (out && out !== 'HEAD') ? out : null;
    }

    /**
     * Directory creation time (birthtime when available, ctime otherwise).
     * Used in place of a stored installedAt timestamp.
     */
    static _installedAt(dir) {
        try {
            const stat = lstatSync(dir);
            return (stat.birthtime || stat.ctime)?.toISOString() || null;
        } catch {
            return null;
        }
    }

    /**
     * Async git rev-parse for code paths that already await.
     */
    static _gitRevAsync(cwd, ref) {
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