/**
 * Epistery crypto primitives — shared encryption services.
 * Ported from @rootz/crypto to pure ESM JavaScript.
 *
 * Three encryption paradigms:
 *   AES-256-GCM     — symmetric content encryption
 *   ECDH secp256k1  — key exchange for sharing
 *   MasterKey       — signature-based key derivation (the epistery pattern)
 */

export { AES } from './aes.mjs';
export { ECDH } from './ecdh.mjs';
export { MasterKey } from './master-key.mjs';
export {
  arrayBufferToHex,
  hexToBytes,
  bytesToHex,
  normalizeHex,
  stripHexPrefix,
  validateHexLength,
  isValidHex,
  randomBytes,
  getCrypto,
} from './utils.mjs';
