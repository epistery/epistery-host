/**
 * KeyManager — shared, per-domain master key lifecycle.
 *
 * Singleton instance used by secret-agent, OAuthServer, and StorageFactory.
 * Each domain gets a master key derived from its domain wallet's signature.
 * Package stored at ~/.epistery/{domain}/secret-agent/master-key.json
 */

import { Config } from 'epistery';
import { MasterKey } from './crypto/master-key.mjs';

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

    const pkg = this._readPackage(domain);
    if (!pkg) {
      if (autoInit && signer) {
        await this.initMasterKey(domain, signer);
        return this.cache.get(domain);
      }
      throw new Error(`No master key for domain ${domain}. Initialize first.`);
    }

    const masterKey = await MasterKey.decryptFromPackage(pkg, signer);
    this.cache.set(domain, masterKey);
    return masterKey;
  }

  /**
   * Check if domain has a master key package on disk.
   * @param {string} domain
   * @returns {boolean}
   */
  hasMasterKey(domain) {
    return !!this._readPackage(domain);
  }

  /**
   * Get master key metadata (not the key itself).
   * @param {string} domain
   * @returns {object|null}
   */
  getKeyInfo(domain) {
    const pkg = this._readPackage(domain);
    if (!pkg) return null;
    return {
      encryptedFor: pkg.encryptedFor,
      timestamp: pkg.timestamp,
      version: pkg.version,
      algorithm: pkg.algorithm,
      valid: MasterKey.isValidPackage(pkg),
    };
  }

  /**
   * Read package from disk. Returns null if not found.
   * @private
   */
  _readPackage(domain) {
    try {
      const config = new Config();
      config.setPath(`/${domain}/secret-agent`);
      const raw = config.readFile('master-key.json');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

// Singleton — one cache, one source of truth
const keyManager = new KeyManager();
export default keyManager;
