/**
 * UserVault — encrypted per-user JSON storage, like server-side cookies.
 *
 * Each authenticated client gets a JSON object stored at vault/{address}.json,
 * encrypted at rest via the domain master key (AES-256-GCM through StorageFactory).
 * Access is gated by authentication — only the owner of the private key
 * (proven via signature or session) can read/write their vault.
 *
 * Mounted as middleware: req.userVault = { get, set, merge }
 * Also exposes REST API at /api/vault for direct client access.
 */

import StorageFactory from './storage/StorageFactory.mjs';

// Per-domain storage backend cache
const storageCache = new Map();

async function getStorage(domain, signer) {
  if (!storageCache.has(domain)) {
    const storage = await StorageFactory.create(null, domain, 'user-vault', signer);
    storageCache.set(domain, storage);
  }
  return storageCache.get(domain);
}

function vaultKey(address) {
  return `vault/${address.toLowerCase()}.json`;
}

function nameVaultKey(name) {
  return `vault/name/${name.toLowerCase()}.json`;
}

export class UserVault {

  /**
   * Read the full vault for an address.
   * @param {object} storage - StorageFactory backend
   * @param {string} address - client address
   * @returns {Promise<object>}
   */
  static async get(storage, address) {
    try {
      const exists = await storage.exists(vaultKey(address));
      if (!exists) return {};
      const raw = await storage.readFile(vaultKey(address));
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  /**
   * Replace the vault for an address.
   * @param {object} storage
   * @param {string} address
   * @param {object} data
   */
  static async set(storage, address, data) {
    await storage.writeFile(vaultKey(address), JSON.stringify(data));
  }

  /**
   * Shallow-merge patch into existing vault.
   * @param {object} storage
   * @param {string} address
   * @param {object} patch
   * @returns {Promise<object>} merged result
   */
  static async merge(storage, address, patch) {
    const existing = await UserVault.get(storage, address);
    const merged = { ...existing, ...patch };
    await UserVault.set(storage, address, merged);
    return merged;
  }

  /** Read the vault for an ACL name. */
  static async getByName(storage, name) {
    try {
      const key = nameVaultKey(name);
      const exists = await storage.exists(key);
      if (!exists) return {};
      const raw = await storage.readFile(key);
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  /** Replace the vault for an ACL name. */
  static async setByName(storage, name, data) {
    await storage.writeFile(nameVaultKey(name), JSON.stringify(data));
  }

  /** Shallow-merge patch into an ACL name vault. */
  static async mergeByName(storage, name, patch) {
    const existing = await UserVault.getByName(storage, name);
    const merged = { ...existing, ...patch };
    await UserVault.setByName(storage, name, merged);
    return merged;
  }

  /**
   * Attach middleware and API routes.
   * After this, req.userVault is available with { get, set, merge } bound to the
   * authenticated client's address.
   *
   * @param {express.Application} app
   */
  static attach(app) {
    // Middleware: attach lazy vault accessor to every authenticated request
    app.use(async (req, res, next) => {
      const address = req.episteryClient?.address;
      if (!address) {
        req.userVault = null;
        return next();
      }

      const domain = req.hostname || 'localhost';
      const signer = req.app.locals.epistery?.signer || null;

      let storage;
      try {
        storage = await getStorage(domain, signer);
      } catch (err) {
        console.error('[user-vault] Storage init error:', err.message);
        req.userVault = null;
        return next();
      }

      // Resolve ACL name for shared (cross-device) vault
      let aclName = null;
      try {
        if (req.domainAcl) {
          aclName = await req.domainAcl.getNameForAddress(address);
        }
      } catch {}

      req.userVault = {
        get: () => UserVault.get(storage, address),
        set: (data) => UserVault.set(storage, address, data),
        merge: (patch) => UserVault.merge(storage, address, patch),
        // Shared: uses name vault when ACL name exists, falls back to address vault
        getShared: () => aclName
          ? UserVault.getByName(storage, aclName)
          : UserVault.get(storage, address),
        setShared: (data) => aclName
          ? UserVault.setByName(storage, aclName, data)
          : UserVault.set(storage, address, data),
        mergeShared: (patch) => aclName
          ? UserVault.mergeByName(storage, aclName, patch)
          : UserVault.merge(storage, address, patch),
        sharedName: aclName
      };

      next();
    });

    // API: read entire vault
    app.get('/api/vault', async (req, res) => {
      if (!req.userVault) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      try {
        const data = await req.userVault.get();
        res.json(data);
      } catch (err) {
        console.error('[user-vault] Read error:', err.message);
        res.status(500).json({ error: 'Failed to read vault' });
      }
    });

    // API: shallow-merge into vault
    app.patch('/api/vault', async (req, res) => {
      if (!req.userVault) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      try {
        const merged = await req.userVault.merge(req.body);
        res.json(merged);
      } catch (err) {
        console.error('[user-vault] Merge error:', err.message);
        res.status(500).json({ error: 'Failed to update vault' });
      }
    });

    // API: read single key
    app.get('/api/vault/:key', async (req, res) => {
      if (!req.userVault) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      try {
        const data = await req.userVault.get();
        const value = data[req.params.key];
        if (value === undefined) {
          return res.status(404).json({ error: 'Key not found' });
        }
        res.json(value);
      } catch (err) {
        console.error('[user-vault] Read key error:', err.message);
        res.status(500).json({ error: 'Failed to read vault key' });
      }
    });

    // API: set single key
    app.put('/api/vault/:key', async (req, res) => {
      if (!req.userVault) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      try {
        const data = await req.userVault.get();
        data[req.params.key] = req.body;
        await req.userVault.set(data);
        res.json(data);
      } catch (err) {
        console.error('[user-vault] Write key error:', err.message);
        res.status(500).json({ error: 'Failed to write vault key' });
      }
    });

    console.log('[user-vault] Middleware and API routes attached');
  }
}
