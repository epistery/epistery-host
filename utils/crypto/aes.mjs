/**
 * AES-256-GCM encryption/decryption.
 * Ported from @rootz/crypto aes.ts to pure ESM JavaScript.
 *
 * Uses Web Crypto API (crypto.subtle) — available since Node 15.
 * 256-bit key, 96-bit IV, 128-bit authentication tag.
 */

import {
  hexToBytes,
  bytesToHex,
  validateHexLength,
  randomBytes,
  getCrypto,
} from './utils.mjs';

/** Convert Uint8Array to ArrayBuffer for Web Crypto compatibility */
function toBuffer(arr) {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
}

export class AES {
  /**
   * Encrypt content with AES-256-GCM.
   * @param {string} content - plaintext
   * @param {string} key - hex-encoded 32-byte key
   * @returns {Promise<{encrypted: string, iv: string, algorithm: string}>}
   */
  static async encrypt(content, key) {
    const crypto = getCrypto();
    validateHexLength(key, 32);
    const keyBytes = hexToBytes(key);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', toBuffer(keyBytes),
      { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );

    const iv = randomBytes(12);
    const contentBytes = new TextEncoder().encode(content);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
      cryptoKey, toBuffer(contentBytes)
    );

    return {
      encrypted: bytesToHex(new Uint8Array(ciphertext)),
      iv: bytesToHex(iv),
      algorithm: 'AES-256-GCM',
    };
  }

  /**
   * Decrypt content with AES-256-GCM.
   * @param {{encrypted: string, iv: string}} data
   * @param {string} key - hex-encoded 32-byte key
   * @returns {Promise<string>}
   */
  static async decrypt(data, key) {
    const crypto = getCrypto();
    validateHexLength(key, 32);
    const keyBytes = hexToBytes(key);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', toBuffer(keyBytes),
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );

    const ciphertext = hexToBytes(data.encrypted);
    const iv = hexToBytes(data.iv);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
      cryptoKey, toBuffer(ciphertext)
    );

    return new TextDecoder().decode(plaintext);
  }

  /**
   * Encrypt IPFS hash with master key (VDN pattern).
   * Hides real IPFS location from blockchain analysis.
   * @param {string} ipfsHash
   * @param {string} masterKey - hex key
   * @returns {Promise<{encrypted: string, iv: string, version: string}>}
   */
  static async encryptIPFSHash(ipfsHash, masterKey) {
    const crypto = getCrypto();
    validateHexLength(masterKey, 32);
    const keyBytes = hexToBytes(masterKey);
    const iv = randomBytes(12);
    const hashBytes = new TextEncoder().encode(ipfsHash);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', toBuffer(keyBytes),
      { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
      cryptoKey, toBuffer(hashBytes)
    );

    return {
      encrypted: bytesToHex(new Uint8Array(ciphertext)),
      iv: bytesToHex(iv),
      version: '5.0',
    };
  }

  /**
   * Decrypt IPFS hash from VDN encrypted data.
   * @param {{encrypted: string, iv: string}} vdn
   * @param {string} masterKey
   * @returns {Promise<string>}
   */
  static async decryptIPFSHash(vdn, masterKey) {
    const crypto = getCrypto();
    validateHexLength(masterKey, 32);
    const keyBytes = hexToBytes(masterKey);
    const ciphertext = hexToBytes(vdn.encrypted);
    const iv = hexToBytes(vdn.iv);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', toBuffer(keyBytes),
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
      cryptoKey, toBuffer(ciphertext)
    );

    return new TextDecoder().decode(plaintext);
  }

  /**
   * Encrypt raw bytes with AES-256-GCM.
   * @param {Uint8Array} data
   * @param {string} key - hex key
   * @returns {Promise<{encrypted: Uint8Array, iv: Uint8Array}>}
   */
  static async encryptBytes(data, key) {
    const crypto = getCrypto();
    validateHexLength(key, 32);
    const keyBytes = hexToBytes(key);
    const iv = randomBytes(12);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', toBuffer(keyBytes),
      { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
      cryptoKey, toBuffer(data)
    );

    return { encrypted: new Uint8Array(ciphertext), iv };
  }

  /**
   * Decrypt raw bytes with AES-256-GCM.
   * @param {Uint8Array} encrypted
   * @param {Uint8Array} iv
   * @param {string} key - hex key
   * @returns {Promise<Uint8Array>}
   */
  static async decryptBytes(encrypted, iv, key) {
    const crypto = getCrypto();
    validateHexLength(key, 32);
    const keyBytes = hexToBytes(key);

    const cryptoKey = await crypto.subtle.importKey(
      'raw', toBuffer(keyBytes),
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
      cryptoKey, toBuffer(encrypted)
    );

    return new Uint8Array(plaintext);
  }

  /**
   * Derive AES key from arbitrary data using SHA-256.
   * @param {string|Uint8Array} data
   * @returns {Promise<string>} 32-byte hex key
   */
  static async deriveKey(data) {
    const crypto = getCrypto();
    const dataBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const hash = await crypto.subtle.digest('SHA-256', toBuffer(dataBytes));
    return bytesToHex(new Uint8Array(hash));
  }
}
