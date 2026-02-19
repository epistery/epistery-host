/**
 * Signature-based master key encryption.
 * Ported from @rootz/crypto master-key.ts to pure ESM JavaScript.
 *
 * CONTRACT (version 1.x — DO NOT CHANGE):
 * - Address must be EIP-55 checksummed
 * - Signature message: "Storage key for master key encryption\nOwner: {address}\nPurpose: encrypt-master-key"
 * - Key derivation: SHA-256(signature) -> AES-256-GCM key
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { utils: ethersUtils } = require('ethers');

import {
  hexToBytes,
  bytesToHex,
  randomBytes,
  getCrypto,
} from './utils.mjs';

/** Convert Uint8Array to ArrayBuffer for Web Crypto compatibility */
function toBuffer(arr) {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
}

export class MasterKey {
  /**
   * Create the standard storage key signature message.
   * CONTRACT: This EXACT format must never change in version 1.x
   * @param {string} ownerAddress - EIP-55 checksummed
   * @returns {string}
   */
  static createStorageKeyMessage(ownerAddress) {
    return `Storage key for master key encryption\nOwner: ${ownerAddress}\nPurpose: encrypt-master-key`;
  }

  /**
   * Generate a random 32-byte master key.
   * @returns {string} hex with 0x prefix
   */
  static generate() {
    return bytesToHex(randomBytes(32));
  }

  /**
   * Encrypt master key using signature-based key derivation.
   * @param {string} masterKey - hex
   * @param {string} ownerAddress - Ethereum address
   * @param {object} signer - ethers.js Signer
   * @param {object} [extensions] - metadata (secretName, secretType, contractAddress)
   * @returns {Promise<object>} MasterKeyPackage
   */
  static async encryptForOwner(masterKey, ownerAddress, signer, extensions = {}) {
    const crypto = getCrypto();
    const checksummed = ethersUtils.getAddress(ownerAddress);
    const message = this.createStorageKeyMessage(checksummed);
    const signature = await signer.signMessage(message);

    // Derive storage key: SHA-256(signature)
    const sigData = new TextEncoder().encode(signature);
    const keyMaterial = await crypto.subtle.digest('SHA-256', toBuffer(sigData));

    const storageKey = await crypto.subtle.importKey(
      'raw', keyMaterial,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt']
    );

    const iv = randomBytes(12);
    const masterKeyData = new TextEncoder().encode(masterKey);

    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
      storageKey, toBuffer(masterKeyData)
    );

    return {
      version: '1.0.0',
      algorithm: 'AES-256-GCM',
      keyDerivation: 'signature-storage-key',
      encryptedKey: bytesToHex(new Uint8Array(encrypted)),
      iv: bytesToHex(iv),
      encryptedFor: checksummed,
      timestamp: Date.now(),
      extensions: { ...extensions },
    };
  }

  /**
   * Decrypt master key from encrypted package.
   * @param {object} pkg - MasterKeyPackage
   * @param {object} signer - owner's Signer (must match encryptedFor)
   * @returns {Promise<string>} decrypted master key hex
   */
  static async decryptFromPackage(pkg, signer) {
    const crypto = getCrypto();
    const signerAddress = await signer.getAddress();
    const checksummed = ethersUtils.getAddress(signerAddress);

    if (pkg.encryptedFor !== checksummed) {
      throw new Error(
        `Package encrypted for ${pkg.encryptedFor}, but signer is ${checksummed}`
      );
    }

    // Use encryptedFor from package for exact address format match
    const message = this.createStorageKeyMessage(pkg.encryptedFor);
    const signature = await signer.signMessage(message);

    const sigData = new TextEncoder().encode(signature);
    const keyMaterial = await crypto.subtle.digest('SHA-256', toBuffer(sigData));

    const storageKey = await crypto.subtle.importKey(
      'raw', keyMaterial,
      { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );

    const encryptedData = hexToBytes(pkg.encryptedKey);
    const iv = hexToBytes(pkg.iv);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
      storageKey, toBuffer(encryptedData)
    );

    return new TextDecoder().decode(decrypted);
  }

  /**
   * Verify that a package structure is valid.
   * @param {*} pkg
   * @returns {boolean}
   */
  static isValidPackage(pkg) {
    if (!pkg || typeof pkg !== 'object') return false;
    return (
      pkg.version === '1.0.0' &&
      pkg.algorithm === 'AES-256-GCM' &&
      pkg.keyDerivation === 'signature-storage-key' &&
      typeof pkg.encryptedKey === 'string' &&
      typeof pkg.iv === 'string' &&
      typeof pkg.encryptedFor === 'string' &&
      typeof pkg.timestamp === 'number' &&
      typeof pkg.extensions === 'object'
    );
  }
}
