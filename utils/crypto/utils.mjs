/**
 * Crypto utility functions — hex conversion and validation.
 * Ported from @rootz/crypto utils.ts to pure ESM JavaScript.
 */

/**
 * Convert ArrayBuffer or Uint8Array to hex string (no prefix).
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
export function arrayBufferToHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to Uint8Array.
 * @param {string} hex - with or without 0x prefix
 * @returns {Uint8Array}
 */
export function hexToBytes(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string with 0x prefix.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex(bytes) {
  return '0x' + arrayBufferToHex(bytes);
}

/**
 * Add 0x prefix if missing.
 * @param {string} hex
 * @returns {string}
 */
export function normalizeHex(hex) {
  return hex.startsWith('0x') ? hex : '0x' + hex;
}

/**
 * Remove 0x prefix.
 * @param {string} hex
 * @returns {string}
 */
export function stripHexPrefix(hex) {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

/**
 * Validate hex string has expected byte length.
 * @param {string} hex
 * @param {number} expectedBytes
 */
export function validateHexLength(hex, expectedBytes) {
  const clean = stripHexPrefix(hex);
  if (clean.length !== expectedBytes * 2) {
    throw new Error(
      `Invalid hex length: got ${clean.length / 2} bytes, expected ${expectedBytes} bytes`
    );
  }
}

/**
 * Check if string is valid hex.
 * @param {string} hex
 * @returns {boolean}
 */
export function isValidHex(hex) {
  const clean = stripHexPrefix(hex);
  return /^[0-9a-fA-F]*$/.test(clean) && clean.length % 2 === 0;
}

/**
 * Generate cryptographically secure random bytes.
 * @param {number} length
 * @returns {Uint8Array}
 */
export function randomBytes(length) {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Get the global crypto object (Web Crypto API).
 * @returns {Crypto}
 */
export function getCrypto() {
  if (globalThis.crypto) return globalThis.crypto;
  throw new Error('No Web Crypto API available. Use Node.js 19+ or a modern browser.');
}
