import { Config } from 'epistery';
import StorjStorage from './StorjStorage.mjs';

/**
 * Storage factory that creates the appropriate storage backend
 * based on configuration
 */
export default class StorageFactory {
  /**
   * Create storage instance based on config
   * @param {string} type - Storage type: 'config', 'storj', 'ipfs'
   * @param {string} domain - Domain name for config-based storage
   * @param {string} agentName - Agent name for storage path prefix (e.g., 'wiki', 'files')
   */
  static async create(type, domain = 'localhost', agentName = 'wiki') {
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

    switch (type.toLowerCase()) {
      case 'storj':
        return await StorageFactory.createStorj(domain, agentName);

      case 'config':
        return StorageFactory.createConfig(domain, agentName);

      case 'ipfs':
        throw new Error('IPFS storage not yet implemented');

      default:
        throw new Error(`Unknown storage type: ${type}`);
    }
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
          const fullSubdirPath = require('path').join(config.currentDir, subdirPath);
          if (!require('fs').existsSync(fullSubdirPath)) {
            require('fs').mkdirSync(fullSubdirPath, { recursive: true });
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
