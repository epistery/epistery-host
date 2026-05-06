/**
 * Shared crypto type definitions (JSDoc).
 * Ported from @rootz/crypto types.ts — no TypeScript, just documentation.
 *
 * These types describe the wire format of encrypted packages stored on-chain
 * or in config files.
 */

/**
 * @typedef {Object} EncryptedData
 * @property {string} encrypted - Hex-encoded ciphertext with auth tag appended
 * @property {string} iv - 12 bytes hex
 * @property {string} algorithm - Always 'AES-256-GCM'
 */

/**
 * @typedef {Object} VDNHash
 * @property {string} encrypted - Hex-encoded encrypted IPFS hash
 * @property {string} iv - 12 bytes hex
 * @property {string} version - Always '5.0'
 */

/**
 * @typedef {Object} MasterKeyPackage
 * @property {string} version - '1.0.0'
 * @property {string} algorithm - 'AES-256-GCM'
 * @property {string} keyDerivation - 'signature-storage-key'
 * @property {string} encryptedKey - Hex
 * @property {string} iv - Hex
 * @property {string} encryptedFor - EIP-55 checksummed address
 * @property {number} timestamp
 * @property {Object} extensions
 */

/**
 * @typedef {Object} ECDHEncryptedPackage
 * @property {string} ciphertext - Hex-encoded ciphertext
 * @property {string} iv - 12 bytes hex
 * @property {string} authTag - 16 bytes hex
 */

/**
 * @typedef {Object} KeyPair
 * @property {string} privateKey - 32 bytes hex
 * @property {string} publicKey - 65 bytes hex, uncompressed (0x04...)
 */

/**
 * @typedef {Object} DeviceKeyEntry
 * @property {string} deviceAddress - Ethereum address of the device
 * @property {string} [deviceName] - Human-readable device label
 * @property {string} ephemeralPub - One-time public key used for encryption
 * @property {ECDHEncryptedPackage} encryptedMasterKey - Master key encrypted for this device
 * @property {ECDHEncryptedPackage} [encryptedKeyVaultKey] - Optional secondary key
 */

/**
 * Fat package — multi-device encrypted master key bundle.
 * Each device entry is self-contained: the device can decrypt using
 * its private key + the ephemeralPub in its entry.
 *
 * @typedef {Object} FatPackage
 * @property {string} type - Always 'fat-key-package'
 * @property {string} version - '3.0'
 * @property {string} secretContract - Address of the secret/keyvault contract
 * @property {number} keyVaultBlock - Block number of keyvault event
 * @property {string} secretName - Human-readable secret name
 * @property {string} [identityContract] - Identity contract that owns this secret
 * @property {number} chainId - EVM chain ID
 * @property {string} [chainName] - Human-readable chain name
 * @property {number} timestamp - Creation timestamp (ms)
 * @property {DeviceKeyEntry[]} devices - One entry per authorized device
 */

/**
 * Single device package — used in LOCAL mode where the wallet is both
 * creator and owner. On-chain recoverable using the device's private key.
 *
 * @typedef {Object} SingleDevicePackage
 * @property {string} type - Always 'single-device-package'
 * @property {string} version - '1.0'
 * @property {string} secretContract - Contract address
 * @property {string} deviceAddress - Device address
 * @property {string} ephemeralPub - Ephemeral public key
 * @property {ECDHEncryptedPackage} encryptedMasterKey - Encrypted master key
 * @property {ECDHEncryptedPackage} [encryptedKeyVaultKey] - Optional secondary key
 * @property {string} algorithm - 'ECDH-AES-256-GCM'
 * @property {number} timestamp - Creation timestamp (ms)
 */

/**
 * V5 KeyVault format from on-chain events — can be single-device or multi-device.
 *
 * @typedef {Object} V5KeyVaultData
 * @property {boolean} [isMultiDevice] - True if deviceEntries[] present
 * @property {ECDHEncryptedPackage} [encryptedMasterKey] - Single-device encrypted key
 * @property {string} [ephemeralPub] - Single-device ephemeral public key
 * @property {DeviceKeyEntry[]} [deviceEntries] - Multi-device entries
 */

export const PACKAGE_TYPES = {
  FAT: 'fat-key-package',
  SINGLE: 'single-device-package',
};

export const VERSIONS = {
  FAT: '3.0',
  SINGLE: '1.0',
};
