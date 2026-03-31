import { Config } from 'epistery';
import StorjStorage from './StorjStorage.mjs';
import EncryptedStorage from './EncryptedStorage.mjs';
import keyManager from '../KeyManager.mjs';
import path from 'path';
import fs from 'fs';

/**
 * Storage factory that creates the appropriate storage backend
 * based on configuration. When a signer is provided, storage is
 * wrapped with EncryptedStorage for transparent AES-256-GCM encryption.
 */
export default class StorageFactory {
  /**
   * Create storage instance based on config
   * @param {string} type - Storage type: 'config', 'storj', 'ipfs' (null for auto-detect)
   * @param {string} domain - Domain name for config-based storage
   * @param {string} agentName - Agent name for storage path prefix (e.g., 'wiki', 'files')
   * @param {object} [signer] - ethers.js Signer for encrypted storage. If provided, all
   *   data is encrypted at rest with AES-256-GCM using the domain's master key.
   */
  static async create(type, domain = 'localhost', agentName = 'wiki', signer = null) {
    if (!type) {
      // Auto-detect based on what's configured - prefer Storj
      type = 'storj'; // Default to storj

      try {
        const config = new Config();
        const domainConfig = config.read(`/${domain}`);
        const rootConfig = config.read('/');

        // Check if Storj credentials are present in domain config, fallback to root config
        const storjConfig = domainConfig.storj || rootConfig.storj;

        if (storjConfig?.ACCESS_KEY &&
            storjConfig?.SECRET_KEY &&
            storjConfig?.ENDPOINT) {
          type = 'storj';
          console.log(`[${agentName}:storage] Using Storj storage${domainConfig.storj ? '' : ' (from root config)'}`);
        } else {
          type = 'config';
          console.log(`[${agentName}:storage] Storj not configured, falling back to Config storage`);
        }
      } catch (err) {
        // Error reading config, use config storage
        type = 'config';
        console.log(`[${agentName}:storage] Config read error, using Config storage (default)`);
      }
    }

    let storage;
    switch (type.toLowerCase()) {
      case 'storj':
        storage = await StorageFactory.createStorj(domain, agentName);
        break;

      case 'config':
        storage = StorageFactory.createConfig(domain, agentName);
        break;

      case 'ipfs':
        throw new Error('IPFS storage not yet implemented');

      default:
        throw new Error(`Unknown storage type: ${type}`);
    }

    // Wrap with encryption if signer is available and encryption not disabled
    if (signer) {
      const config = new Config();
      const domainConfig = config.read(`/${domain}`);
      const encryptionDisabled = domainConfig.storage_encrypted === 'false';

      if (!encryptionDisabled) {
        try {
          const masterKey = await keyManager.getMasterKey(domain, signer, true);
          storage = new EncryptedStorage(storage, masterKey);
          console.log(`[${agentName}:storage] Encrypted storage enabled`);
        } catch (err) {
          console.error(`[${agentName}:storage] Failed to initialize encryption, using plaintext:`, err.message);
        }
      } else {
        console.log(`[${agentName}:storage] Encryption disabled by domain config`);
      }
    }

    return storage;
  }

  /**
   * Create Storj storage instance
   * @param {string} domain - Domain name for config lookup
   * @param {string} agentName - Agent name for storage path prefix
   */
  static async createStorj(domain = 'localhost', agentName = 'wiki') {
    const storage = new StorjStorage(domain, agentName);
    await storage.initialize();
    return storage;
  }

  /**
   * Create Config storage instance (current implementation)
   * @param {string} domain - Domain name for path prefix
   * @param {string} agentName - Agent name for storage path prefix
   */
  static createConfig(domain = 'localhost', agentName = 'wiki') {
    const config = new Config();
    config.setPath(`/${domain}/${agentName}`);

    // Wrap Config with the same interface as other storage backends
    return {
      writeFile: (key, content) => {
        // Ensure the base directory exists
        config.save();

        // If key contains subdirectories, ensure they exist
        const keyParts = key.split('/');
        if (keyParts.length > 1) {
          const subdirPath = keyParts.slice(0, -1).join('/');
          const fullSubdirPath = path.join(config.currentDir, subdirPath);
          if (!fs.existsSync(fullSubdirPath)) {
            fs.mkdirSync(fullSubdirPath, { recursive: true });
          }
        }

        config.writeFile(key, content);
        return Promise.resolve(true);
      },

      readFile: (key) => {
        return Promise.resolve(config.readFile(key));
      },

      exists: (key) => {
        try {
          config.readFile(key);
          return Promise.resolve(true);
        } catch (error) {
          return Promise.resolve(false);
        }
      },

      listFiles: (prefix) => {
        // Config doesn't support listing, return empty array
        return Promise.resolve([]);
      },

      deleteFile: (key) => {
        // Config doesn't support deletion easily, just resolve
        console.warn(`[config:storage] Delete not implemented for ${key}`);
        return Promise.resolve(true);
      },

      deleteFiles: (keys) => {
        console.warn(`[config:storage] Delete not implemented for ${keys.length} files`);
        return Promise.resolve({ succeeded: 0, failed: keys.length });
      }
    };
  }
}
