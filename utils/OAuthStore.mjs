/**
 * OAuthStore — encrypted storage for OAuth 2.1 entities.
 *
 * Follows the SecretStore pattern:
 *   clients/index.json          — registered OAuth clients (plaintext metadata)
 *   clients/{id}.json           — client details (encrypted)
 *   tokens/index.json           — active tokens metadata
 *   tokens/{hash}.json          — full token record (encrypted)
 *   consent/index.json          — consent records metadata
 *   consent/{id}.json           — consent with authorizer (encrypted)
 *   connections/index.json      — outbound connections metadata
 *   connections/{id}.json       — outbound credentials (encrypted)
 */

import crypto from 'crypto';
import StorageFactory from './storage/StorageFactory.mjs';
import EncryptedStorage from './storage/EncryptedStorage.mjs';

export default class OAuthStore {
  constructor(storage, masterKey) {
    this.raw = storage;
    this.encrypted = new EncryptedStorage(storage, masterKey);
  }

  static async create(domain, masterKey) {
    const storage = await StorageFactory.create(null, domain, 'oauth-agent');
    return new OAuthStore(storage, masterKey);
  }

  // ── Helpers ──

  async _readIndex(prefix) {
    try {
      const exists = await this.raw.exists(`${prefix}/index.json`);
      if (!exists) return {};
      const raw = await this.raw.readFile(`${prefix}/index.json`);
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  async _writeIndex(prefix, data) {
    await this.raw.writeFile(`${prefix}/index.json`, JSON.stringify(data, null, 2));
  }

  _hash(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  _generateToken(prefix) {
    return prefix + crypto.randomBytes(32).toString('hex');
  }

  // ── Clients ──

  async createClient({ name, redirect_uris, grant_types, response_types, scope, token_endpoint_auth_method }) {
    const client_id = 'rootz_client_' + crypto.randomUUID().replace(/-/g, '');
    const client_secret = crypto.randomBytes(32).toString('hex');
    const created = Date.now();

    const record = {
      client_id,
      client_secret,
      name: name || 'Unknown Client',
      redirect_uris: redirect_uris || [],
      grant_types: grant_types || ['authorization_code'],
      response_types: response_types || ['code'],
      scope: scope || '',
      token_endpoint_auth_method: token_endpoint_auth_method || 'none',
      created
    };

    await this.encrypted.writeFile(`clients/${client_id}.json`, JSON.stringify(record));

    const index = await this._readIndex('clients');
    index[client_id] = { client_id, name: record.name, created, redirect_uris: record.redirect_uris };
    await this._writeIndex('clients', index);

    return record;
  }

  async getClient(client_id) {
    try {
      const raw = await this.encrypted.readFile(`clients/${client_id}.json`);
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async getOrCreateClient({ name, redirect_uris, grant_types, response_types, scope, token_endpoint_auth_method }) {
    const index = await this._readIndex('clients');
    // Match by name + redirect_uris
    for (const meta of Object.values(index)) {
      if (meta.name === name && JSON.stringify(meta.redirect_uris) === JSON.stringify(redirect_uris)) {
        return this.getClient(meta.client_id);
      }
    }
    return this.createClient({ name, redirect_uris, grant_types, response_types, scope, token_endpoint_auth_method });
  }

  async setClientWallet(client_id, wallet) {
    const client = await this.getClient(client_id);
    if (!client) return null;
    client.wallet = wallet;
    await this.encrypted.writeFile(`clients/${client_id}.json`, JSON.stringify(client));

    const index = await this._readIndex('clients');
    if (index[client_id]) {
      index[client_id].wallet = wallet;
      await this._writeIndex('clients', index);
    }
    return client;
  }

  async listClients() {
    const index = await this._readIndex('clients');
    return Object.values(index);
  }

  // ── Authorization Codes ──

  async createAuthorizationCode({ client_id, redirect_uri, scope, code_challenge, code_challenge_method, wallet, authorizer }) {
    const code = crypto.randomBytes(32).toString('base64url');
    const created = Date.now();
    const expires = created + 5 * 60 * 1000; // 5 minutes

    const record = {
      code,
      client_id,
      redirect_uri,
      scope,
      code_challenge,
      code_challenge_method: code_challenge_method || 'S256',
      wallet,
      authorizer,
      created,
      expires,
      consumed: false
    };

    const hash = this._hash(code);
    await this.encrypted.writeFile(`codes/${hash}.json`, JSON.stringify(record));
    return { code, expires };
  }

  async consumeAuthorizationCode(code) {
    const hash = this._hash(code);
    try {
      const raw = await this.encrypted.readFile(`codes/${hash}.json`);
      const record = JSON.parse(raw);

      if (record.consumed) return null;
      if (Date.now() > record.expires) return null;

      record.consumed = true;
      await this.encrypted.writeFile(`codes/${hash}.json`, JSON.stringify(record));
      return record;
    } catch {
      return null;
    }
  }

  // ── PKCE ──

  verifyPKCE(code_verifier, code_challenge, method) {
    if (method !== 'S256') return false;
    const hash = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    return hash === code_challenge;
  }

  // ── Tokens ──

  async createTokenPair({ client_id, wallet, scope }) {
    const access_token = this._generateToken('rootz_at_');
    const refresh_token = this._generateToken('rootz_rt_');
    const created = Date.now();
    const access_expires = created + 60 * 60 * 1000;    // 1 hour
    const refresh_expires = created + 30 * 24 * 60 * 60 * 1000; // 30 days

    const accessRecord = {
      token_type: 'access',
      client_id,
      wallet,
      scope,
      created,
      expires: access_expires
    };

    const refreshRecord = {
      token_type: 'refresh',
      client_id,
      wallet,
      scope,
      access_token_hash: this._hash(access_token),
      created,
      expires: refresh_expires
    };

    const atHash = this._hash(access_token);
    const rtHash = this._hash(refresh_token);

    await this.encrypted.writeFile(`tokens/${atHash}.json`, JSON.stringify(accessRecord));
    await this.encrypted.writeFile(`tokens/${rtHash}.json`, JSON.stringify(refreshRecord));

    // Update tokens index
    const index = await this._readIndex('tokens');
    index[atHash] = { client_id, wallet, scope, type: 'access', expires: access_expires, created };
    index[rtHash] = { client_id, wallet, scope, type: 'refresh', expires: refresh_expires, created };
    await this._writeIndex('tokens', index);

    return {
      access_token,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token,
      scope
    };
  }

  async validateAccessToken(token) {
    if (!token || !token.startsWith('rootz_at_')) return null;
    const hash = this._hash(token);
    try {
      const raw = await this.encrypted.readFile(`tokens/${hash}.json`);
      const record = JSON.parse(raw);
      if (record.token_type !== 'access') return null;
      if (Date.now() > record.expires) return null;
      return record;
    } catch {
      return null;
    }
  }

  async refreshTokens(refresh_token, client_id) {
    if (!refresh_token || !refresh_token.startsWith('rootz_rt_')) return null;
    const hash = this._hash(refresh_token);
    try {
      const raw = await this.encrypted.readFile(`tokens/${hash}.json`);
      const record = JSON.parse(raw);
      if (record.token_type !== 'refresh') return null;
      if (Date.now() > record.expires) return null;
      if (record.client_id !== client_id) return null;

      // Revoke old refresh token
      const index = await this._readIndex('tokens');
      delete index[hash];
      // Also remove old access token
      if (record.access_token_hash && index[record.access_token_hash]) {
        delete index[record.access_token_hash];
      }
      await this._writeIndex('tokens', index);

      // Issue new pair
      return this.createTokenPair({
        client_id: record.client_id,
        wallet: record.wallet,
        scope: record.scope
      });
    } catch {
      return null;
    }
  }

  async revokeToken(token) {
    const hash = this._hash(token);
    const index = await this._readIndex('tokens');
    if (index[hash]) {
      delete index[hash];
      await this._writeIndex('tokens', index);
      return true;
    }
    return false;
  }

  async revokeTokensForWallet(wallet) {
    const index = await this._readIndex('tokens');
    let revoked = 0;
    for (const [hash, meta] of Object.entries(index)) {
      if (meta.wallet === wallet) {
        delete index[hash];
        revoked++;
      }
    }
    if (revoked > 0) await this._writeIndex('tokens', index);
    return revoked;
  }

  // ── Consent ──

  async recordConsent({ client_id, wallet, scope, authorizer }) {
    const id = crypto.randomUUID();
    const created = Date.now();

    const record = { id, client_id, wallet, scope, authorizer, created };
    await this.encrypted.writeFile(`consent/${id}.json`, JSON.stringify(record));

    const index = await this._readIndex('consent');
    index[id] = { id, client_id, wallet, scope, created };
    await this._writeIndex('consent', index);

    return record;
  }

  async hasConsent(client_id, wallet, scope) {
    const index = await this._readIndex('consent');
    return Object.values(index).some(c =>
      c.client_id === client_id && c.wallet === wallet && c.scope === scope
    );
  }

  async revokeConsent(id) {
    const index = await this._readIndex('consent');
    if (index[id]) {
      delete index[id];
      await this._writeIndex('consent', index);
      return true;
    }
    return false;
  }

  async listConsent() {
    const index = await this._readIndex('consent');
    return Object.values(index);
  }

  // ── Outbound Connections ──

  async addConnection({ service, name, credentials, type }) {
    const id = crypto.randomUUID();
    const created = Date.now();

    const record = { id, service, name, credentials, type: type || 'outbound', created };
    await this.encrypted.writeFile(`connections/${id}.json`, JSON.stringify(record));

    const index = await this._readIndex('connections');
    index[id] = { id, service, name, type: record.type, created };
    await this._writeIndex('connections', index);

    return { id, service, name, type: record.type, created };
  }

  async getConnection(id) {
    try {
      const raw = await this.encrypted.readFile(`connections/${id}.json`);
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async listConnections() {
    const index = await this._readIndex('connections');
    return Object.values(index);
  }

  async removeConnection(id) {
    const index = await this._readIndex('connections');
    if (index[id]) {
      delete index[id];
      await this._writeIndex('connections', index);
      return true;
    }
    return false;
  }
}
