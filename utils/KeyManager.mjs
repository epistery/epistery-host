/**
 * KeyManager — shared, per-domain master key lifecycle.
 *
 * Singleton instance used by secret-agent, OAuthServer, and StorageFactory.
 * Each domain gets a master key derived from its domain wallet's signature.
 * Package stored at ~/.epistery/{domain}/secret-agent/master-key.json
 */

import { Config } from 'epistery';
import { MasterKey } from './crypto/master-key.mjs';
import { ECDH } from './crypto/ecdh.mjs';
import { PACKAGE_TYPES } from './crypto/types.mjs';

class KeyManager {
  constructor() {
    this.cache = new Map(); // domain -> decrypted master key (in-memory only)
  }

  /**
   * Initialize master key for a domain.
   * Signs deterministic message with domain wallet, derives key, stores encrypted package.
   * @param {string} domain
   * @param {object} signer - ethers.js Signer
   * @returns {Promise<object>} package metadata (not the key)
   */
  async initMasterKey(domain, signer) {
    const existing = this.hasMasterKey(domain);
    if (existing) {
      throw new Error(`Master key already initialized for ${domain}. Delete it first to re-initialize.`);
    }

    const masterKey = MasterKey.generate();
    const ownerAddress = await signer.getAddress();

    const pkg = await MasterKey.encryptForOwner(masterKey, ownerAddress, signer);

    // Store encrypted package in config
    const config = new Config();
    config.setPath(`/${domain}/secret-agent`);
    config.save();
    config.writeFile('master-key.json', JSON.stringify(pkg, null, 2));

    // Cache decrypted key
    this.cache.set(domain, masterKey);

    console.log(`[key-manager] Master key initialized for ${domain}`);

    return {
      encryptedFor: pkg.encryptedFor,
      timestamp: pkg.timestamp,
      version: pkg.version,
    };
  }

  /**
   * Get (decrypt) master key for a domain. Auto-initializes if signer provided and no key exists.
   * Migrates legacy keys from /{domain}/master-key.json to /{domain}/secret-agent/master-key.json.
   * @param {string} domain
   * @param {object} signer - ethers.js Signer
   * @param {boolean} [autoInit=false] - initialize if missing
   * @returns {Promise<string>} hex master key
   */
  async getMasterKey(domain, signer, autoInit = false) {
    // Return cached if available
    if (this.cache.has(domain)) {
      return this.cache.get(domain);
    }

    const { pkg, legacy } = this._readPackage(domain);
    if (!pkg) {
      if (autoInit && signer) {
        await this.initMasterKey(domain, signer);
        return this.cache.get(domain);
      }
      throw new Error(`No master key for domain ${domain}. Initialize first.`);
    }

    // Detect package format and decrypt accordingly
    let masterKey;
    if (pkg.type === PACKAGE_TYPES.FAT) {
      // Fat package — find device entry by wallet address and decrypt
      const address = await signer.getAddress();
      masterKey = await ECDH.decryptFromFatPackage(pkg, address, signer.privateKey);
      console.log(`[key-manager] Decrypted fat package for ${domain} (device: ${address})`);
    } else if (pkg.type === PACKAGE_TYPES.SINGLE) {
      // Single device package — decrypt via ephemeral key
      masterKey = await ECDH.decryptSingleDevicePackage(pkg, signer.privateKey);
      console.log(`[key-manager] Decrypted single-device package for ${domain}`);
    } else {
      // Legacy signature-based master key package
      masterKey = await MasterKey.decryptFromPackage(pkg, signer);
    }
    this.cache.set(domain, masterKey);

    // Migrate legacy key to canonical path
    if (legacy) {
      try {
        const config = new Config();
        config.setPath(`/${domain}/secret-agent`);
        config.save();
        config.writeFile('master-key.json', JSON.stringify(pkg, null, 2));
        console.log(`[key-manager] Migrated legacy master key for ${domain} to secret-agent/`);
      } catch (err) {
        console.warn(`[key-manager] Failed to migrate legacy key for ${domain}:`, err.message);
      }
    }

    return masterKey;
  }

  /**
   * Check if domain has a master key package on disk.
   * @param {string} domain
   * @returns {boolean}
   */
  hasMasterKey(domain) {
    return !!this._readPackage(domain).pkg;
  }

  /**
   * Get master key metadata (not the key itself).
   * @param {string} domain
   * @returns {object|null}
   */
  getKeyInfo(domain) {
    const { pkg } = this._readPackage(domain);
    if (!pkg) return null;

    // Fat package or single-device package
    if (pkg.type === PACKAGE_TYPES.FAT) {
      return {
        type: pkg.type,
        version: pkg.version,
        timestamp: pkg.timestamp,
        deviceCount: pkg.devices?.length || 0,
        identityContract: pkg.identityContract || null,
        valid: true,
      };
    }
    if (pkg.type === PACKAGE_TYPES.SINGLE) {
      return {
        type: pkg.type,
        version: pkg.version,
        timestamp: pkg.timestamp,
        deviceAddress: pkg.deviceAddress,
        valid: true,
      };
    }

    // Legacy signature-based package
    return {
      type: 'signature-based',
      encryptedFor: pkg.encryptedFor,
      timestamp: pkg.timestamp,
      version: pkg.version,
      algorithm: pkg.algorithm,
      valid: MasterKey.isValidPackage(pkg),
    };
  }

  /**
   * Read package from disk. Returns {pkg, legacy} where legacy is true if
   * the key was found at the pre-refactor path (/{domain}/master-key.json).
   * When keys exist at both paths (conflict from auto-init), the legacy key
   * takes priority since it was created first and has more data encrypted with it.
   * @private
   */
  _readPackage(domain) {
    const result = { pkg: null, legacy: false };
    const locations = [
      { path: `/${domain}/secret-agent`, legacy: false },
      { path: `/${domain}`,              legacy: true  }
    ];
    for (const loc of locations) {
      try {
        const config = new Config();
        config.setPath(loc.path);
        const raw = config.readFile('master-key.json');
        const pkg = JSON.parse(raw);
        if (pkg && MasterKey.isValidPackage(pkg)) {
          if (loc.legacy && result.pkg) {
            // Legacy key exists AND canonical key exists — legacy wins (has more encrypted data)
            console.warn(`[key-manager] Conflict: master keys at both paths for ${domain}, using legacy key`);
          }
          result.pkg = pkg;
          result.legacy = loc.legacy;
          if (loc.legacy) return result; // Legacy found — use it, stop looking
        }
      } catch {
        // try next path
      }
    }
    return result;
  }
}

// Singleton — one cache, one source of truth
const keyManager = new KeyManager();
export default keyManager;
