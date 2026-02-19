/**
 * EncryptedStorage — transparent AES-256-GCM encryption wrapper.
 *
 * Wraps any storage backend (Config, Storj) with encryption.
 * Same interface as StorageFactory backends so agents can swap in transparently:
 *   new EncryptedStorage(storage, masterKey) instead of storage directly.
 *
 * Metadata operations (exists, listFiles) pass through unencrypted.
 */

import { AES } from '../crypto/aes.mjs';

export default class EncryptedStorage {
  /**
   * @param {object} storage - any StorageFactory backend (Config or Storj)
   * @param {string} masterKey - hex-encoded 32-byte AES key
   */
  constructor(storage, masterKey) {
    this.storage = storage;
    this.masterKey = masterKey;
  }

  /**
   * Encrypt content and write to storage.
   * @param {string} key - storage key/path
   * @param {string} content - plaintext content
   */
  async writeFile(key, content) {
    const encrypted = await AES.encrypt(content, this.masterKey);
    return this.storage.writeFile(key, JSON.stringify(encrypted));
  }

  /**
   * Read from storage and decrypt.
   * @param {string} key - storage key/path
   * @returns {Promise<string>} decrypted content
   */
  async readFile(key) {
    const raw = await this.storage.readFile(key);
    const encrypted = JSON.parse(raw);
    return AES.decrypt(encrypted, this.masterKey);
  }

  /**
   * Check if key exists (metadata, not encrypted).
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  async exists(key) {
    return this.storage.exists(key);
  }

  /**
   * List files by prefix (metadata, not encrypted).
   * @param {string} prefix
   * @returns {Promise<string[]>}
   */
  async listFiles(prefix) {
    return this.storage.listFiles(prefix);
  }

  /**
   * Delete a file.
   * @param {string} key
   */
  async deleteFile(key) {
    return this.storage.deleteFile(key);
  }

  /**
   * Delete multiple files.
   * @param {string[]} keys
   */
  async deleteFiles(keys) {
    return this.storage.deleteFiles(keys);
  }
}
