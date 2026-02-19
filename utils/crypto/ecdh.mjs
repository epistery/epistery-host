/**
 * ECDH key exchange for team member key sharing.
 * Ported from @rootz/crypto ecdh.ts — core + ephemeral methods.
 *
 * Uses secp256k1 curve via ethers.js SigningKey (Ethereum compatible).
 * Fat packages and V5 KeyVault are deferred to identity convergence.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { utils: ethersUtils } = require('ethers');
const { SigningKey } = ethersUtils;

import {
  hexToBytes,
  bytesToHex,
  stripHexPrefix,
  getCrypto,
  randomBytes as cryptoRandomBytes,
} from './utils.mjs';

/** Convert Uint8Array to ArrayBuffer for Web Crypto compatibility */
function toBuffer(arr) {
  return arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength);
}

export class ECDH {
  /**
   * Generate a new secp256k1 key pair.
   * @returns {{privateKey: string, publicKey: string}}
   */
  static generateKeyPair() {
    const privateKeyBytes = cryptoRandomBytes(32);
    const privateKey = ethersUtils.hexlify(privateKeyBytes);
    const signingKey = new SigningKey(privateKey);
    return { privateKey, publicKey: signingKey.publicKey };
  }

  /**
   * Derive public key from private key.
   * @param {string} privateKey - hex
   * @returns {string} uncompressed public key (0x04...)
   */
  static derivePublicKey(privateKey) {
    return new SigningKey(privateKey).publicKey;
  }

  /**
   * Compute ECDH shared secret.
   * myPrivKey * theirPubKey == theirPrivKey * myPubKey
   * @param {string} myPrivateKey - hex
   * @param {string} theirPublicKey - hex, uncompressed (0x04...)
   * @returns {string} shared secret hex
   */
  static computeSharedSecret(myPrivateKey, theirPublicKey) {
    const pubClean = stripHexPrefix(theirPublicKey);
    if (pubClean.length !== 130) {
      throw new Error(`Invalid public key length: ${pubClean.length / 2} bytes (must be 65 bytes uncompressed)`);
    }
    if (!pubClean.startsWith('04')) {
      throw new Error('Public key must be uncompressed (start with 04)');
    }
    const signingKey = new SigningKey(myPrivateKey);
    return signingKey.computeSharedSecret(theirPublicKey);
  }

  /**
   * Derive AES-256 CryptoKey from ECDH shared secret via SHA-256.
   * @param {string} sharedSecret - hex
   * @returns {Promise<CryptoKey>}
   */
  static async deriveAESKey(sharedSecret) {
    const crypto = getCrypto();
    const secretBytes = hexToBytes(sharedSecret);
    const keyMaterial = await crypto.subtle.digest('SHA-256', toBuffer(secretBytes));
    return crypto.subtle.importKey(
      'raw', keyMaterial,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt content for a recipient using ECDH + AES-256-GCM.
   * @param {string} content - plaintext
   * @param {string} myPrivateKey
   * @param {string} theirPublicKey
   * @returns {Promise<{ciphertext: string, iv: string, authTag: string}>}
   */
  static async encryptForRecipient(content, myPrivateKey, theirPublicKey) {
    const crypto = getCrypto();
    const sharedSecret = this.computeSharedSecret(myPrivateKey, theirPublicKey);
    const aesKey = await this.deriveAESKey(sharedSecret);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintextBytes = new TextEncoder().encode(content);

    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
      aesKey, toBuffer(plaintextBytes)
    );

    // GCM appends 16-byte auth tag to ciphertext
    const full = new Uint8Array(ciphertextBuf);
    const encData = full.slice(0, -16);
    const authTag = full.slice(-16);

    return {
      ciphertext: bytesToHex(encData),
      iv: bytesToHex(iv),
      authTag: bytesToHex(authTag),
    };
  }

  /**
   * Decrypt content from a sender using ECDH + AES-256-GCM.
   * @param {{ciphertext: string, iv: string, authTag: string}} encrypted
   * @param {string} myPrivateKey
   * @param {string} senderPublicKey
   * @returns {Promise<string>}
   */
  static async decryptFromSender(encrypted, myPrivateKey, senderPublicKey) {
    const crypto = getCrypto();
    const sharedSecret = this.computeSharedSecret(myPrivateKey, senderPublicKey);
    const aesKey = await this.deriveAESKey(sharedSecret);

    const ciphertextBytes = hexToBytes(encrypted.ciphertext);
    const authTagBytes = hexToBytes(encrypted.authTag);
    const ivBytes = hexToBytes(encrypted.iv);

    // Reassemble ciphertext + authTag for Web Crypto
    const combined = new Uint8Array(ciphertextBytes.length + authTagBytes.length);
    combined.set(ciphertextBytes, 0);
    combined.set(authTagBytes, ciphertextBytes.length);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(ivBytes), tagLength: 128 },
      aesKey, toBuffer(combined)
    );

    return new TextDecoder().decode(plaintext);
  }

  /**
   * Encrypt master key for a device using ephemeral keys.
   * One-time ephemeral key pair — encrypting device doesn't store private key.
   * @param {string} masterKey - hex
   * @param {string} devicePublicKey - hex, uncompressed
   * @returns {Promise<{ephemeralPub: string, encryptedMasterKey: {ciphertext: string, iv: string, authTag: string}}>}
   */
  static async encryptForDevice(masterKey, devicePublicKey) {
    const ephemeral = this.generateKeyPair();

    // Encrypt using ephemeral private x device public
    const encrypted = await this.encryptMasterKeyForMember(
      masterKey, ephemeral.privateKey, devicePublicKey
    );

    // Ephemeral private key discarded after this scope
    return {
      ephemeralPub: ephemeral.publicKey,
      encryptedMasterKey: encrypted,
    };
  }

  /**
   * Decrypt master key using ephemeral public key.
   * @param {{ciphertext: string, iv: string, authTag: string}} encrypted
   * @param {string} ephemeralPub
   * @param {string} devicePrivateKey
   * @returns {Promise<string>} decrypted master key hex
   */
  static async decryptFromEphemeral(encrypted, ephemeralPub, devicePrivateKey) {
    return this.decryptMasterKeyFromOwner(encrypted, devicePrivateKey, ephemeralPub);
  }

  /**
   * Encrypt master key for team member (Owner -> Member).
   * @param {string} masterKey - hex
   * @param {string} myPrivateKey
   * @param {string} memberPublicKey
   * @returns {Promise<{ciphertext: string, iv: string, authTag: string}>}
   */
  static async encryptMasterKeyForMember(masterKey, myPrivateKey, memberPublicKey) {
    const crypto = getCrypto();
    const sharedSecret = this.computeSharedSecret(myPrivateKey, memberPublicKey);
    const aesKey = await this.deriveAESKey(sharedSecret);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = stripHexPrefix(masterKey);
    const plaintextBytes = hexToBytes(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: toBuffer(iv), tagLength: 128 },
      aesKey, toBuffer(plaintextBytes)
    );

    const full = new Uint8Array(ciphertext);
    const encData = full.slice(0, -16);
    const authTag = full.slice(-16);

    return {
      ciphertext: bytesToHex(encData),
      iv: bytesToHex(iv),
      authTag: bytesToHex(authTag),
    };
  }

  /**
   * Decrypt master key from team owner (Member perspective).
   * @param {{ciphertext: string, iv: string, authTag: string}} encrypted
   * @param {string} myPrivateKey
   * @param {string} ownerPublicKey
   * @returns {Promise<string>} decrypted master key hex
   */
  static async decryptMasterKeyFromOwner(encrypted, myPrivateKey, ownerPublicKey) {
    const crypto = getCrypto();
    const sharedSecret = this.computeSharedSecret(myPrivateKey, ownerPublicKey);
    const aesKey = await this.deriveAESKey(sharedSecret);

    const ciphertextBytes = hexToBytes(encrypted.ciphertext);
    const authTagBytes = hexToBytes(encrypted.authTag);
    const ivBytes = hexToBytes(encrypted.iv);

    const combined = new Uint8Array(ciphertextBytes.length + authTagBytes.length);
    combined.set(ciphertextBytes, 0);
    combined.set(authTagBytes, ciphertextBytes.length);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBuffer(ivBytes), tagLength: 128 },
      aesKey, toBuffer(combined)
    );

    return bytesToHex(new Uint8Array(plaintext));
  }

  /**
   * Verify that a public key is valid uncompressed secp256k1.
   * @param {string} publicKey - hex
   * @returns {boolean}
   */
  static isValidPublicKey(publicKey) {
    try {
      const clean = stripHexPrefix(publicKey);
      if (clean.length !== 130 || !clean.startsWith('04')) return false;
      const testPrivate = ethersUtils.hexlify(cryptoRandomBytes(32));
      new SigningKey(testPrivate).computeSharedSecret('0x' + clean);
      return true;
    } catch {
      return false;
    }
  }
}
