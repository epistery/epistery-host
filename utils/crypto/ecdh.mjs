/**
 * ECDH key exchange for team member key sharing.
 * Ported from @rootz/crypto ecdh.ts — core, ephemeral, fat package methods.
 *
 * Uses secp256k1 curve via ethers.js SigningKey (Ethereum compatible).
 * Fat packages enable multi-device decryption: one encrypted master key entry
 * per rivet on an IdentityContract, each independently decryptable.
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

  // ═══ Fat Package — Multi-Device Master Key Bundles ═══

  /**
   * Create a fat package: encrypt master key for multiple devices at once.
   * Each device entry is self-contained — no dependency on the creator after creation.
   *
   * @param {string} masterKey - hex master key to encrypt
   * @param {Array<{address: string, publicKey: string, name?: string}>} devices - target devices
   * @param {Object} metadata
   * @param {string} metadata.secretContract - contract address
   * @param {number} [metadata.keyVaultBlock] - block number
   * @param {string} [metadata.secretName] - human-readable name
   * @param {string} [metadata.identityContract] - identity contract address
   * @param {number} [metadata.chainId] - EVM chain ID
   * @param {string} [metadata.chainName] - human-readable chain name
   * @returns {Promise<import('./types.mjs').FatPackage>}
   */
  static async createFatPackage(masterKey, devices, metadata = {}) {
    if (!devices || devices.length === 0) {
      throw new Error('At least one device required for fat package');
    }

    const deviceEntries = [];
    for (const device of devices) {
      if (!device.publicKey || !device.address) {
        throw new Error(`Device missing publicKey or address: ${JSON.stringify(device)}`);
      }
      const entry = await this.encryptForDevice(masterKey, device.publicKey);
      deviceEntries.push({
        deviceAddress: device.address,
        deviceName: device.name || undefined,
        ephemeralPub: entry.ephemeralPub,
        encryptedMasterKey: entry.encryptedMasterKey,
      });
    }

    return {
      type: 'fat-key-package',
      version: '3.0',
      secretContract: metadata.secretContract || '',
      keyVaultBlock: metadata.keyVaultBlock || 0,
      secretName: metadata.secretName || '',
      identityContract: metadata.identityContract || undefined,
      chainId: metadata.chainId || 0,
      chainName: metadata.chainName || undefined,
      timestamp: Date.now(),
      devices: deviceEntries,
    };
  }

  /**
   * Decrypt master key from a fat package.
   * Finds the device entry matching the given address and decrypts.
   *
   * @param {import('./types.mjs').FatPackage} fatPackage
   * @param {string} deviceAddress - address of the decrypting device
   * @param {string} devicePrivateKey - hex private key
   * @returns {Promise<string>} decrypted master key hex
   */
  static async decryptFromFatPackage(fatPackage, deviceAddress, devicePrivateKey) {
    const entry = fatPackage.devices.find(
      d => d.deviceAddress.toLowerCase() === deviceAddress.toLowerCase()
    );

    if (!entry) {
      const available = fatPackage.devices.map(d => d.deviceAddress).join(', ');
      throw new Error(`Device ${deviceAddress} not found in fat package. Available: ${available}`);
    }

    return this.decryptFromEphemeral(
      entry.encryptedMasterKey,
      entry.ephemeralPub,
      devicePrivateKey
    );
  }

  /**
   * Add a device to an existing fat package.
   * Requires the decrypted master key (caller must already have access).
   *
   * @param {import('./types.mjs').FatPackage} fatPackage
   * @param {string} masterKey - decrypted master key hex
   * @param {{address: string, publicKey: string, name?: string}} newDevice
   * @returns {Promise<import('./types.mjs').FatPackage>} new fat package with added device
   */
  static async addDeviceToFatPackage(fatPackage, masterKey, newDevice) {
    const exists = fatPackage.devices.some(
      d => d.deviceAddress.toLowerCase() === newDevice.address.toLowerCase()
    );
    if (exists) {
      throw new Error(`Device ${newDevice.address} already in fat package`);
    }

    const entry = await this.encryptForDevice(masterKey, newDevice.publicKey);

    return {
      ...fatPackage,
      timestamp: Date.now(),
      devices: [
        ...fatPackage.devices,
        {
          deviceAddress: newDevice.address,
          deviceName: newDevice.name || undefined,
          ephemeralPub: entry.ephemeralPub,
          encryptedMasterKey: entry.encryptedMasterKey,
        }
      ],
    };
  }

  // ═══ Single Device Package — LOCAL mode ═══

  /**
   * Create a single-device package (LOCAL mode).
   * The wallet is both creator and owner — on-chain recoverable.
   *
   * @param {string} masterKey - hex master key
   * @param {string} devicePublicKey - hex public key
   * @param {string} secretContract - contract address
   * @param {string} deviceAddress - device address
   * @returns {Promise<import('./types.mjs').SingleDevicePackage>}
   */
  static async createSingleDevicePackage(masterKey, devicePublicKey, secretContract, deviceAddress) {
    const entry = await this.encryptForDevice(masterKey, devicePublicKey);

    return {
      type: 'single-device-package',
      version: '1.0',
      secretContract,
      deviceAddress,
      ephemeralPub: entry.ephemeralPub,
      encryptedMasterKey: entry.encryptedMasterKey,
      algorithm: 'ECDH-AES-256-GCM',
      timestamp: Date.now(),
    };
  }

  /**
   * Decrypt from a single-device package.
   *
   * @param {import('./types.mjs').SingleDevicePackage} pkg
   * @param {string} devicePrivateKey - hex private key
   * @returns {Promise<string>} decrypted master key hex
   */
  static async decryptSingleDevicePackage(pkg, devicePrivateKey) {
    return this.decryptFromEphemeral(
      pkg.encryptedMasterKey,
      pkg.ephemeralPub,
      devicePrivateKey
    );
  }

  // ═══ V5 KeyVault format (on-chain compatibility) ═══

  /**
   * Decrypt from V5 KeyVault data found on-chain.
   * Handles both single-device and multi-device formats.
   *
   * @param {import('./types.mjs').V5KeyVaultData} keysData
   * @param {string} deviceAddress - address of the decrypting device
   * @param {string} devicePrivateKey - hex private key
   * @returns {Promise<string>} decrypted master key hex
   */
  static async decryptFromV5KeyVaultData(keysData, deviceAddress, devicePrivateKey) {
    if (keysData.isMultiDevice && keysData.deviceEntries) {
      // Multi-device: search deviceEntries by address
      const entry = keysData.deviceEntries.find(
        d => d.deviceAddress.toLowerCase() === deviceAddress.toLowerCase()
      );
      if (!entry) {
        throw new Error(`Device ${deviceAddress} not found in V5 KeyVault multi-device data`);
      }
      if (!entry.ephemeralPub) {
        throw new Error('Device entry missing ephemeralPub');
      }
      return this.decryptFromEphemeral(
        entry.encryptedMasterKey,
        entry.ephemeralPub,
        devicePrivateKey
      );
    }

    // Single device: use top-level encryptedMasterKey
    if (!keysData.ephemeralPub) {
      throw new Error('V5 KeyVault data missing ephemeralPub for single-device decryption');
    }
    return this.decryptFromEphemeral(
      keysData.encryptedMasterKey,
      keysData.ephemeralPub,
      devicePrivateKey
    );
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
