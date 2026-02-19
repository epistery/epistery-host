/**
 * Crypto module unit tests.
 * Tests encrypt/decrypt round-trips, ECDH shared secret symmetry,
 * MasterKey derivation, and data format compatibility with rootz.
 */

import { describe, it, expect } from 'vitest';
import { AES, ECDH, MasterKey, hexToBytes, bytesToHex, isValidHex, randomBytes } from '../utils/crypto/index.mjs';
import EncryptedStorage from '../utils/storage/EncryptedStorage.mjs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Wallet } = require('ethers');

// ---------- Utils ----------

describe('crypto utils', () => {
  it('hexToBytes and bytesToHex round-trip', () => {
    const hex = '0xdeadbeef01020304';
    const bytes = hexToBytes(hex);
    expect(bytes.length).toBe(8);
    expect(bytesToHex(bytes)).toBe(hex);
  });

  it('isValidHex validates correctly', () => {
    expect(isValidHex('0xabcdef')).toBe(true);
    expect(isValidHex('abcdef')).toBe(true);
    expect(isValidHex('0xgg')).toBe(false);
    expect(isValidHex('abc')).toBe(false); // odd length
  });

  it('randomBytes produces correct length', () => {
    const bytes = randomBytes(32);
    expect(bytes.length).toBe(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });
});

// ---------- AES ----------

describe('AES', () => {
  const testKey = bytesToHex(randomBytes(32));

  it('encrypt/decrypt round-trip', async () => {
    const content = 'Hello, epistery encryption!';
    const encrypted = await AES.encrypt(content, testKey);

    expect(encrypted.algorithm).toBe('AES-256-GCM');
    expect(encrypted.encrypted).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();

    const decrypted = await AES.decrypt(encrypted, testKey);
    expect(decrypted).toBe(content);
  });

  it('different keys produce different ciphertext', async () => {
    const key2 = bytesToHex(randomBytes(32));
    const content = 'secret data';

    const enc1 = await AES.encrypt(content, testKey);
    const enc2 = await AES.encrypt(content, key2);

    expect(enc1.encrypted).not.toBe(enc2.encrypted);
  });

  it('decrypt with wrong key fails', async () => {
    const wrongKey = bytesToHex(randomBytes(32));
    const encrypted = await AES.encrypt('test', testKey);

    await expect(AES.decrypt(encrypted, wrongKey)).rejects.toThrow();
  });

  it('encryptIPFSHash/decryptIPFSHash round-trip (VDN format)', async () => {
    const hash = 'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
    const vdn = await AES.encryptIPFSHash(hash, testKey);

    expect(vdn.version).toBe('5.0');
    expect(vdn.encrypted).toBeTruthy();
    expect(vdn.iv).toBeTruthy();

    const decrypted = await AES.decryptIPFSHash(vdn, testKey);
    expect(decrypted).toBe(hash);
  });

  it('encryptBytes/decryptBytes round-trip', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { encrypted, iv } = await AES.encryptBytes(data, testKey);

    const decrypted = await AES.decryptBytes(encrypted, iv, testKey);
    expect(Array.from(decrypted)).toEqual(Array.from(data));
  });

  it('deriveKey is deterministic', async () => {
    const key1 = await AES.deriveKey('my passphrase');
    const key2 = await AES.deriveKey('my passphrase');
    expect(key1).toBe(key2);
    expect(isValidHex(key1)).toBe(true);
  });
});

// ---------- ECDH ----------

describe('ECDH', () => {
  it('generateKeyPair produces valid keys', () => {
    const kp = ECDH.generateKeyPair();
    expect(kp.privateKey).toBeTruthy();
    expect(kp.publicKey.startsWith('0x04')).toBe(true);
    expect(hexToBytes(kp.publicKey).length).toBe(65);
  });

  it('derivePublicKey matches generateKeyPair', () => {
    const kp = ECDH.generateKeyPair();
    const derived = ECDH.derivePublicKey(kp.privateKey);
    expect(derived).toBe(kp.publicKey);
  });

  it('shared secret is symmetric', () => {
    const alice = ECDH.generateKeyPair();
    const bob = ECDH.generateKeyPair();

    const secretA = ECDH.computeSharedSecret(alice.privateKey, bob.publicKey);
    const secretB = ECDH.computeSharedSecret(bob.privateKey, alice.publicKey);

    expect(secretA).toBe(secretB);
  });

  it('encryptForRecipient/decryptFromSender round-trip', async () => {
    const alice = ECDH.generateKeyPair();
    const bob = ECDH.generateKeyPair();
    const message = 'Encrypted message for Bob';

    const encrypted = await ECDH.encryptForRecipient(
      message, alice.privateKey, bob.publicKey
    );

    expect(encrypted.ciphertext).toBeTruthy();
    expect(encrypted.iv).toBeTruthy();
    expect(encrypted.authTag).toBeTruthy();

    const decrypted = await ECDH.decryptFromSender(
      encrypted, bob.privateKey, alice.publicKey
    );

    expect(decrypted).toBe(message);
  });

  it('encryptForDevice/decryptFromEphemeral round-trip', async () => {
    const device = ECDH.generateKeyPair();
    const masterKey = bytesToHex(randomBytes(32));

    const { ephemeralPub, encryptedMasterKey } = await ECDH.encryptForDevice(
      masterKey, device.publicKey
    );

    expect(ephemeralPub.startsWith('0x04')).toBe(true);

    const decrypted = await ECDH.decryptFromEphemeral(
      encryptedMasterKey, ephemeralPub, device.privateKey
    );

    expect(decrypted).toBe(masterKey);
  });

  it('encryptMasterKeyForMember/decryptMasterKeyFromOwner round-trip', async () => {
    const owner = ECDH.generateKeyPair();
    const member = ECDH.generateKeyPair();
    const masterKey = bytesToHex(randomBytes(32));

    const encrypted = await ECDH.encryptMasterKeyForMember(
      masterKey, owner.privateKey, member.publicKey
    );

    const decrypted = await ECDH.decryptMasterKeyFromOwner(
      encrypted, member.privateKey, owner.publicKey
    );

    expect(decrypted).toBe(masterKey);
  });

  it('isValidPublicKey validates correctly', () => {
    const kp = ECDH.generateKeyPair();
    expect(ECDH.isValidPublicKey(kp.publicKey)).toBe(true);
    expect(ECDH.isValidPublicKey('0x0000')).toBe(false);
    expect(ECDH.isValidPublicKey('not-hex')).toBe(false);
  });
});

// ---------- MasterKey ----------

describe('MasterKey', () => {
  it('createStorageKeyMessage matches rootz contract format', () => {
    const addr = '0x1234567890AbCdEf1234567890aBcDeF12345678';
    const msg = MasterKey.createStorageKeyMessage(addr);
    expect(msg).toBe(
      `Storage key for master key encryption\nOwner: ${addr}\nPurpose: encrypt-master-key`
    );
  });

  it('generate produces valid 32-byte hex key', () => {
    const key = MasterKey.generate();
    expect(isValidHex(key)).toBe(true);
    expect(hexToBytes(key).length).toBe(32);
  });

  it('encryptForOwner/decryptFromPackage round-trip', async () => {
    const wallet = Wallet.createRandom();
    const masterKey = MasterKey.generate();

    const pkg = await MasterKey.encryptForOwner(masterKey, wallet.address, wallet);

    expect(pkg.version).toBe('1.0.0');
    expect(pkg.algorithm).toBe('AES-256-GCM');
    expect(pkg.keyDerivation).toBe('signature-storage-key');
    expect(pkg.encryptedFor).toBeTruthy();

    const decrypted = await MasterKey.decryptFromPackage(pkg, wallet);
    expect(decrypted).toBe(masterKey);
  });

  it('decryptFromPackage rejects wrong signer', async () => {
    const owner = Wallet.createRandom();
    const imposter = Wallet.createRandom();
    const masterKey = MasterKey.generate();

    const pkg = await MasterKey.encryptForOwner(masterKey, owner.address, owner);

    await expect(
      MasterKey.decryptFromPackage(pkg, imposter)
    ).rejects.toThrow(/but signer is/);
  });

  it('isValidPackage checks structure', async () => {
    const wallet = Wallet.createRandom();
    const masterKey = MasterKey.generate();
    const pkg = await MasterKey.encryptForOwner(masterKey, wallet.address, wallet);

    expect(MasterKey.isValidPackage(pkg)).toBe(true);
    expect(MasterKey.isValidPackage({})).toBe(false);
    expect(MasterKey.isValidPackage(null)).toBe(false);
  });
});

// ---------- EncryptedStorage ----------

describe('EncryptedStorage', () => {
  it('write/read round-trip through mock storage', async () => {
    const store = {};
    const mockStorage = {
      writeFile: (key, content) => { store[key] = content; return Promise.resolve(true); },
      readFile: (key) => Promise.resolve(store[key]),
      exists: (key) => Promise.resolve(key in store),
      listFiles: () => Promise.resolve(Object.keys(store)),
      deleteFile: (key) => { delete store[key]; return Promise.resolve(true); },
      deleteFiles: (keys) => { keys.forEach(k => delete store[k]); return Promise.resolve({ succeeded: keys.length, failed: 0 }); },
    };

    const masterKey = bytesToHex(randomBytes(32));
    const enc = new EncryptedStorage(mockStorage, masterKey);

    const content = 'This is secret content!';
    await enc.writeFile('test.json', content);

    // Raw storage should have encrypted data, not plaintext
    const raw = store['test.json'];
    expect(raw).not.toContain('secret content');
    expect(JSON.parse(raw).algorithm).toBe('AES-256-GCM');

    // Decrypted read should match
    const decrypted = await enc.readFile('test.json');
    expect(decrypted).toBe(content);
  });
});
