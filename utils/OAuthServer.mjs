/**
 * OAuthServer — Core OAuth 2.1 server infrastructure for epistery-host.
 *
 * Mounts directly in index.mjs via OAuthServer.attach(app), same pattern as DomainAcl.
 * Provides:
 *   - RFC 8414 / RFC 9728 metadata endpoints
 *   - Dynamic Client Registration (RFC 7591)
 *   - Authorization + consent flow (browser-based admin or async pending approval)
 *   - Token exchange (auth code + PKCE, refresh)
 *   - Token revocation
 *   - Bearer middleware (validates rootz_at_* tokens)
 *   - Async approval for server-to-server OAuth (pending-requests pattern)
 *
 * OAuth tokens carry the authorizer's real address — the signed identity of the
 * admin who approved the connection. No synthetic/derived addresses.
 *
 * Server-to-server flow:
 *   1. AI POSTs to /oauth/authorize without admin session
 *   2. System creates pending request (same file as ACL access requests)
 *   3. Admin approves on /admin page
 *   4. AI polls GET /oauth/authorize/poll?request_id=... and gets auth code
 *   5. AI exchanges code for tokens at POST /oauth/token
 */

import crypto from 'crypto';
import ethers from 'ethers';
import { Config } from 'epistery';
import keyManager from './KeyManager.mjs';
import OAuthStore from './OAuthStore.mjs';
import { DomainChain } from './DomainChain.mjs';

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SCOPES = [
  'archive:read', 'archive:write',
  'wiki:read', 'wiki:write',
  'secrets:read', 'secrets:create',
  'messages:read', 'messages:write'
];

export class OAuthServer {
  static keyManager = keyManager;
  static stores = new Map();
  static csrfTokens = new Map(); // token -> expiry timestamp
  static registrationLimits = new Map(); // ip -> { count, resetAt }

  static _generateCsrf() {
    const token = crypto.randomBytes(32).toString('hex');
    // Expire in 10 minutes, clean stale entries
    const now = Date.now();
    OAuthServer.csrfTokens.set(token, now + 10 * 60 * 1000);
    for (const [t, exp] of OAuthServer.csrfTokens) {
      if (exp < now) OAuthServer.csrfTokens.delete(t);
    }
    return token;
  }

  static _validateCsrf(token) {
    if (!token) return false;
    const expiry = OAuthServer.csrfTokens.get(token);
    if (!expiry) return false;
    OAuthServer.csrfTokens.delete(token); // single-use
    return Date.now() < expiry;
  }

  static _checkRateLimit(ip) {
    const now = Date.now();
    const limit = OAuthServer.registrationLimits.get(ip);
    if (!limit || limit.resetAt < now) {
      OAuthServer.registrationLimits.set(ip, { count: 1, resetAt: now + 60 * 60 * 1000 });
      return true;
    }
    if (limit.count >= 10) return false;
    limit.count++;
    return true;
  }

  /**
   * Get or create OAuthStore for a domain.
   * Returns null if master key not initialized.
   */
  static async getStore(domain, signer) {
    if (OAuthServer.stores.has(domain)) return OAuthServer.stores.get(domain);
    if (!signer) return null;

    try {
      const masterKey = await OAuthServer.keyManager.getMasterKey(domain, signer, true);
      const store = await OAuthStore.create(domain, masterKey);
      OAuthServer.stores.set(domain, store);
      return store;
    } catch (err) {
      console.error(`[oauth] Failed to init store for ${domain}:`, err.message);
      return null;
    }
  }

  static getDomainWallet(domain) {
    const cfg = new Config();
    cfg.setPath(domain);
    return cfg.data?.wallet?.address || null;
  }

  static getSigner(req) {
    if (req.app.locals.epistery?.signer) return req.app.locals.epistery.signer;
    return null;
  }

  static getIssuer(req) {
    const proto = req.protocol || 'https';
    return `${proto}://${req.hostname}`;
  }

  /**
   * Derive a deterministic per-client address from domain wallet + client_id.
   * keccak256(solidityPack(['address', 'string'], [domainWallet, clientId])) → last 20 bytes → checksummed
   */
  static deriveClientAddress(domainWallet, clientId) {
    const packed = ethers.utils.solidityPack(['address', 'string'], [domainWallet, clientId]);
    const hash = ethers.utils.keccak256(packed);
    const raw = '0x' + hash.slice(-40);
    return ethers.utils.getAddress(raw);
  }

  /**
   * Resolve a rootz_at_ bearer token to the CONNECTION's principal — used at
   * the MCP boundary (MCPServer), never to set a global identity. Returns
   * { caller, clientId, scope } or null.
   *
   * `caller` is the connection's OWN deterministic address (derived from
   * domain wallet + client_id), the same value the contract ACL was granted at
   * consent. The connection's role is NOT decided here — MCPServer reads it
   * from the contract ACL (the source of truth) for this caller. The bearer
   * is intentionally inert outside MCP: it confers no global episteryClient.
   */
  static async resolveBearer(req) {
    const auth = req.headers?.authorization;
    if (!auth || !auth.startsWith('Bearer rootz_at_')) return null;

    const token = auth.slice(7);
    const domain = req.hostname || 'localhost';
    const signer = OAuthServer.getSigner(req);
    if (!signer) return null;

    try {
      const store = await OAuthServer.getStore(domain, signer);
      if (!store) return null;

      const record = await store.validateAccessToken(token);
      if (!record) return null;

      const domainWallet = OAuthServer.getDomainWallet(domain);
      if (!domainWallet) return null;
      const caller = OAuthServer.deriveClientAddress(domainWallet, record.client_id);

      return { caller, clientId: record.client_id || null, scope: record.scope || '' };
    } catch (err) {
      console.error('[oauth] Bearer resolve error:', err.message);
      return null;
    }
  }

  /**
   * Map granted OAuth scope to the contract ACL list + role a connection
   * should receive. Any write/create/admin scope ⇒ editor; otherwise reader.
   * Connections never receive the admin role.
   */
  static _scopeToAcl(scope) {
    const granted = (scope || '').split(' ').filter(Boolean);
    const elevated = granted.some(s => /:(write|create|admin)$/.test(s));
    return elevated
      ? { listName: 'epistery::editor', role: 2 }
      : { listName: 'epistery::reader', role: 1 };
  }

  /**
   * Grant a connection address its scope-derived ACL role on the domain
   * contract (the source of truth). Idempotent: removes any stale epistery::*
   * grant for the address before adding the target. Best-effort when no
   * contract is deployed (logs and returns).
   */
  static async _grantAcl(chain, address, name, scope, meta) {
    if (!chain?.contract) {
      console.warn(`[oauth] No contract deployed — cannot grant ACL for ${address}`);
      return;
    }
    const { listName, role } = OAuthServer._scopeToAcl(scope);
    const memberships = await chain.contract.getListsForMember(address);

    for (const m of memberships) {
      if ((m.listName === 'epistery::editor' || m.listName === 'epistery::reader') && m.listName !== listName) {
        const fee = await chain.getFeeData();
        const tx = await chain.contract.removeFromACL(m.listName, address, fee);
        await tx.wait();
      }
    }

    if (!memberships.some(m => m.listName === listName)) {
      const fee = await chain.getFeeData();
      const tx = await chain.contract.addToACL(listName, address, (name || '').slice(0, 128), role, meta, fee);
      await tx.wait();
      console.log(`[oauth] Granted ${listName} (role ${role}) to connection ${address}`);
    }
  }

  /**
   * Remove a connection address from any epistery::* ACL list. Used on
   * connection/consent revocation.
   */
  static async _revokeAcl(chain, address) {
    if (!chain?.contract || !address) return;
    const memberships = await chain.contract.getListsForMember(address);
    for (const m of memberships) {
      if (m.listName === 'epistery::editor' || m.listName === 'epistery::reader') {
        try {
          const fee = await chain.getFeeData();
          const tx = await chain.contract.removeFromACL(m.listName, address, fee);
          await tx.wait();
          console.log(`[oauth] Revoked ${m.listName} from connection ${address}`);
        } catch (e) {
          console.warn(`[oauth] Revoke ACL ${m.listName} for ${address}:`, e.message);
        }
      }
    }
  }

  /**
   * Read/write pending-requests.json via DomainAcl pattern.
   */
  static _loadPendingRequests(domain) {
    try {
      const cfg = new Config();
      cfg.setPath(domain);
      const data = cfg.readFile('pending-requests.json');
      return JSON.parse(data.toString('utf8'));
    } catch {
      return [];
    }
  }

  static _savePendingRequests(domain, requests) {
    const cfg = new Config();
    cfg.setPath(domain);
    cfg.writeFile('pending-requests.json', JSON.stringify(requests, null, 2));
  }

  /**
   * Attach OAuth 2.1 routes (DCR, consent, token, revocation) to app.
   *
   * Note: OAuth confers NO global identity. A bearer token is inert outside
   * the MCP endpoint — MCPServer resolves it via OAuthServer.resolveBearer()
   * into a per-call { caller, role } principal. epistery middleware remains the
   * sole writer of req.episteryClient (cookie/bot only).
   */
  static attach(app) {
    const self = OAuthServer;

    // ── Well-Known Metadata ──

    app.get('/.well-known/oauth-authorization-server', (req, res) => {
      const issuer = self.getIssuer(req);
      res.json({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        scopes_supported: SCOPES,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
        service_documentation: 'https://wiki.rootz.global'
      });
    });

    app.get('/.well-known/oauth-protected-resource', (req, res) => {
      const issuer = self.getIssuer(req);
      res.json({
        resource: issuer,
        authorization_servers: [issuer],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header']
      });
    });

    app.get('/.well-known/openid-configuration', (req, res) => {
      res.redirect(301, '/.well-known/oauth-authorization-server');
    });

    // ── Dynamic Client Registration (RFC 7591) ──

    app.post('/oauth/register', async (req, res) => {
      const clientIp = req.ip || req.connection?.remoteAddress || 'unknown';
      if (!self._checkRateLimit(clientIp)) {
        return res.status(429).json({ error: 'too_many_requests', error_description: 'Registration rate limit exceeded. Try again later.' });
      }

      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      if (!signer) return res.status(503).json({ error: 'service_unavailable', error_description: 'Signer not ready' });

      const store = await self.getStore(domain, signer);
      if (!store) return res.status(503).json({ error: 'service_unavailable', error_description: 'Master key not initialized' });

      try {
        const { client_name, redirect_uris, grant_types, response_types, scope, token_endpoint_auth_method } = req.body;

        if (!client_name) {
          return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'client_name required' });
        }
        if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
          return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
        }

        const client = await store.createClient({
          name: client_name,
          redirect_uris,
          grant_types: grant_types || ['authorization_code'],
          response_types: response_types || ['code'],
          scope: scope || SCOPES.join(' '),
          token_endpoint_auth_method: token_endpoint_auth_method || 'none'
        });

        res.status(201).json({
          client_id: client.client_id,
          client_secret: client.client_secret,
          client_name: client.name,
          redirect_uris: client.redirect_uris,
          grant_types: client.grant_types,
          response_types: client.response_types,
          scope: client.scope,
          token_endpoint_auth_method: client.token_endpoint_auth_method,
          client_id_issued_at: Math.floor(client.created / 1000)
        });
      } catch (err) {
        console.error('[oauth] Registration error:', err);
        res.status(500).json({ error: 'server_error', error_description: err.message });
      }
    });

    // ── Authorization Endpoint ──

    // GET: serve consent page (browser) or return pending info (server-to-server)
    app.get('/oauth/authorize', async (req, res) => {
      const { client_id, redirect_uri, response_type, scope, state, code_challenge, code_challenge_method } = req.query;

      if (response_type !== 'code') {
        return res.status(400).send(self._errorPage('Unsupported response_type. Only "code" is supported.'));
      }
      if (!client_id) {
        return res.status(400).send(self._errorPage('Missing client_id parameter.'));
      }
      if (!code_challenge || code_challenge_method !== 'S256') {
        return res.status(400).send(self._errorPage('PKCE required. Provide code_challenge with S256 method.'));
      }

      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      const store = signer ? await self.getStore(domain, signer) : null;

      let client = null;
      if (store) client = await store.getClient(client_id);
      if (!client) {
        return res.status(400).send(self._errorPage('Unknown client_id.'));
      }

      if (redirect_uri && !client.redirect_uris.includes(redirect_uri)) {
        return res.status(400).send(self._errorPage('Invalid redirect_uri for this client.'));
      }

      // Check admin auth
      const isAdmin = req.episteryClient && req.domainAcl
        ? await req.domainAcl.isAdmin(req.episteryClient.identityAddress)
        : false;

      if (isAdmin) {
        // Browser-based admin: serve consent page with CSRF token
        const requestedScope = scope || client.scope || '';
        const csrf_token = self._generateCsrf();
        return res.send(self._consentPage({
          client_name: client.name,
          client_id,
          redirect_uri: redirect_uri || client.redirect_uris[0],
          scope: requestedScope,
          state: state || '',
          code_challenge,
          code_challenge_method: code_challenge_method || 'S256',
          domain,
          csrf_token
        }));
      }

      // Not admin — server-to-server: create pending request
      const requestedScope = scope || client.scope || '';
      const request_id = crypto.randomUUID();

      const pendingRequests = self._loadPendingRequests(domain);

      // Check for existing pending request from same client
      const existing = pendingRequests.find(
        r => r.type === 'oauth' && r.client_id === client_id && r.status === 'pending'
      );
      if (existing) {
        return res.json({
          authorization_pending: true,
          request_id: existing.request_id,
          interval: 5,
          message: 'Authorization request already pending admin approval.'
        });
      }

      pendingRequests.push({
        type: 'oauth',
        request_id,
        client_id,
        client_name: client.name,
        scope: requestedScope,
        redirect_uri: redirect_uri || client.redirect_uris[0],
        code_challenge,
        code_challenge_method: code_challenge_method || 'S256',
        state: state || '',
        requestedAt: new Date().toISOString(),
        status: 'pending'
      });

      self._savePendingRequests(domain, pendingRequests);
      console.log(`[oauth] Pending authorization created for client ${client.name} (${request_id})`);

      res.json({
        authorization_pending: true,
        request_id,
        interval: 5,
        message: 'Authorization request submitted. An admin must approve this connection.'
      });
    });

    // POST: process consent (browser admin) or server-to-server request
    app.post('/oauth/authorize', async (req, res) => {
      const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, action, csrf_token } = req.body;

      // Check admin auth
      const isAdmin = req.episteryClient && req.domainAcl
        ? await req.domainAcl.isAdmin(req.episteryClient.identityAddress)
        : false;

      // If not admin: create pending request (same as GET flow but via POST)
      if (!isAdmin) {
        const domain = req.hostname || 'localhost';
        const signer = self.getSigner(req);
        const store = signer ? await self.getStore(domain, signer) : null;
        if (!store) return res.status(503).json({ error: 'service_unavailable' });

        const client = await store.getClient(client_id);
        if (!client) return res.status(400).json({ error: 'invalid_client' });

        const request_id = crypto.randomUUID();
        const pendingRequests = self._loadPendingRequests(domain);

        // Check for existing
        const existing = pendingRequests.find(
          r => r.type === 'oauth' && r.client_id === client_id && r.status === 'pending'
        );
        if (existing) {
          return res.json({
            authorization_pending: true,
            request_id: existing.request_id,
            interval: 5
          });
        }

        const requestedScope = scope || client.scope || '';
        pendingRequests.push({
          type: 'oauth',
          request_id,
          client_id,
          client_name: client.name,
          scope: requestedScope,
          redirect_uri: redirect_uri || client.redirect_uris[0],
          code_challenge: code_challenge || '',
          code_challenge_method: code_challenge_method || 'S256',
          state: state || '',
          requestedAt: new Date().toISOString(),
          status: 'pending'
        });

        self._savePendingRequests(domain, pendingRequests);
        console.log(`[oauth] Pending authorization created for client ${client.name} (${request_id})`);

        return res.json({
          authorization_pending: true,
          request_id,
          interval: 5,
          message: 'Authorization request submitted. An admin must approve this connection.'
        });
      }

      // Admin is present — validate CSRF token
      if (!self._validateCsrf(csrf_token)) {
        return res.status(403).send(self._errorPage('Invalid or expired session. Please go back and try again.'));
      }

      // Admin is present — process consent directly
      const redir = redirect_uri || '';

      if (action === 'deny') {
        if (redir) {
          const sep = redir.includes('?') ? '&' : '?';
          return res.redirect(`${redir}${sep}error=access_denied${state ? '&state=' + encodeURIComponent(state) : ''}`);
        }
        return res.json({ error: 'access_denied' });
      }

      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      const store = signer ? await self.getStore(domain, signer) : null;
      if (!store) return res.status(503).json({ error: 'service_unavailable' });

      const client = await store.getClient(client_id);
      if (!client) return res.status(400).json({ error: 'invalid_client' });

      // The authorizer is the proven admin who clicked Approve (audit only).
      // The connection's PRINCIPAL is its own deterministic address, which we
      // grant a scope-derived ACL role on the contract (the source of truth).
      const authorizerWallet = req.episteryClient.identityAddress;
      const domainWallet = self.getDomainWallet(domain);
      const connectionAddress = self.deriveClientAddress(domainWallet, client_id);
      const grantedScope = scope || '';

      try {
        const aclMeta = JSON.stringify({
          oauth: true,
          clientId: client_id,
          clientName: client.name || '',
          authorizer: authorizerWallet,
          scope: grantedScope,
          addedAt: new Date().toISOString()
        });
        await self._grantAcl(req.domainAcl?.chain, connectionAddress, client.name, grantedScope, aclMeta);

        await store.recordConsent({
          client_id,
          wallet: connectionAddress,
          scope: grantedScope,
          authorizer: authorizerWallet
        });

        const { code } = await store.createAuthorizationCode({
          client_id,
          redirect_uri: redir,
          scope: grantedScope,
          code_challenge,
          code_challenge_method: code_challenge_method || 'S256',
          wallet: connectionAddress,
          authorizer: authorizerWallet
        });

        // Persist the connection's principal address on the client record
        await store.setClientWallet(client_id, connectionAddress);

        if (redir) {
          const sep = redir.includes('?') ? '&' : '?';
          return res.redirect(`${redir}${sep}code=${encodeURIComponent(code)}${state ? '&state=' + encodeURIComponent(state) : ''}`);
        }
        res.json({ code });
      } catch (err) {
        console.error('[oauth] Authorize error:', err);
        res.status(500).json({ error: 'server_error', error_description: err.message });
      }
    });

    // ── Poll for async authorization ──
    // AI agents poll this after getting authorization_pending
    app.get('/oauth/authorize/poll', async (req, res) => {
      const { request_id } = req.query;
      if (!request_id) return res.status(400).json({ error: 'request_id required' });

      const domain = req.hostname || 'localhost';
      const pendingRequests = self._loadPendingRequests(domain);
      const request = pendingRequests.find(r => r.request_id === request_id);

      if (!request) {
        return res.status(404).json({ error: 'authorization_request_not_found' });
      }

      if (request.status === 'pending') {
        return res.json({ status: 'pending', interval: 5 });
      }

      if (request.status === 'denied') {
        return res.json({ status: 'denied', error: 'access_denied' });
      }

      if (request.status === 'approved' && request.authorization_code) {
        return res.json({
          status: 'approved',
          code: request.authorization_code,
          redirect_uri: request.redirect_uri
        });
      }

      // Approved but no code yet (shouldn't happen, but be safe)
      res.json({ status: 'pending', interval: 5 });
    });

    // ── Handle OAuth pending requests (admin approval) ──
    app.post('/oauth/handle-request', async (req, res) => {
      const isAdmin = req.episteryClient && req.domainAcl
        ? await req.domainAcl.isAdmin(req.episteryClient.identityAddress)
        : false;

      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      const { request_id, action } = req.body;
      if (!request_id || !action) {
        return res.status(400).json({ error: 'request_id and action required' });
      }

      const domain = req.hostname || 'localhost';
      const pendingRequests = self._loadPendingRequests(domain);
      const request = pendingRequests.find(
        r => r.request_id === request_id && r.type === 'oauth' && r.status === 'pending'
      );

      if (!request) {
        return res.status(404).json({ error: 'Pending request not found' });
      }

      if (action === 'deny') {
        request.status = 'denied';
        request.deniedAt = new Date().toISOString();
        request.deniedBy = req.episteryClient.identityAddress;
        self._savePendingRequests(domain, pendingRequests);
        return res.json({ success: true, message: 'Authorization denied' });
      }

      if (action === 'approve') {
        const signer = self.getSigner(req);
        const store = signer ? await self.getStore(domain, signer) : null;
        if (!store) return res.status(503).json({ error: 'Master key not initialized' });

        // The approving admin is the authorizer (audit). The connection's
        // principal is its own derived address, granted a scope-derived ACL
        // role on the contract.
        const authorizerWallet = req.episteryClient.identityAddress;
        const domainWallet = self.getDomainWallet(domain);
        const connectionAddress = self.deriveClientAddress(domainWallet, request.client_id);

        try {
          const aclMeta = JSON.stringify({
            oauth: true,
            clientId: request.client_id,
            clientName: request.client_name || '',
            authorizer: authorizerWallet,
            scope: request.scope || '',
            addedAt: new Date().toISOString()
          });
          await self._grantAcl(req.domainAcl?.chain, connectionAddress, request.client_name, request.scope, aclMeta);

          // Record consent
          await store.recordConsent({
            client_id: request.client_id,
            wallet: connectionAddress,
            scope: request.scope,
            authorizer: authorizerWallet
          });

          // Create authorization code
          const { code } = await store.createAuthorizationCode({
            client_id: request.client_id,
            redirect_uri: request.redirect_uri,
            scope: request.scope,
            code_challenge: request.code_challenge,
            code_challenge_method: request.code_challenge_method,
            wallet: connectionAddress,
            authorizer: authorizerWallet
          });

          // Persist the connection's principal address on the client record
          await store.setClientWallet(request.client_id, connectionAddress);

          // Store code on the pending request so poll can return it
          request.status = 'approved';
          request.approvedAt = new Date().toISOString();
          request.approvedBy = req.episteryClient.identityAddress;
          request.authorization_code = code;
          self._savePendingRequests(domain, pendingRequests);

          console.log(`[oauth] Authorization approved for client ${request.client_name} by ${req.episteryClient.identityAddress}`);
          res.json({ success: true, message: 'Authorization approved' });
        } catch (err) {
          console.error('[oauth] Handle request error:', err);
          res.status(500).json({ error: err.message });
        }
      } else {
        res.status(400).json({ error: 'Invalid action. Use approve or deny.' });
      }
    });

    // ── Token Endpoint ──

    app.post('/oauth/token', async (req, res) => {
      const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier, refresh_token } = req.body;

      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      const store = signer ? await self.getStore(domain, signer) : null;
      if (!store) return res.status(503).json({ error: 'service_unavailable' });

      try {
        if (grant_type === 'authorization_code') {
          if (!code || !client_id || !code_verifier) {
            return res.status(400).json({ error: 'invalid_request', error_description: 'code, client_id, and code_verifier required' });
          }

          const authCode = await store.consumeAuthorizationCode(code);
          if (!authCode) {
            return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
          }

          if (authCode.client_id !== client_id) {
            return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id mismatch' });
          }

          if (redirect_uri && authCode.redirect_uri && redirect_uri !== authCode.redirect_uri) {
            return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
          }

          // Verify PKCE
          if (!store.verifyPKCE(code_verifier, authCode.code_challenge, authCode.code_challenge_method)) {
            return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
          }

          // Validate client_secret if required
          const client = await store.getClient(client_id);
          if (client && client.token_endpoint_auth_method === 'client_secret_post') {
            if (client.client_secret !== client_secret) {
              return res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client_secret' });
            }
          }

          const tokens = await store.createTokenPair({
            client_id,
            wallet: authCode.wallet,
            scope: authCode.scope
          });

          res.json(tokens);

        } else if (grant_type === 'refresh_token') {
          if (!refresh_token || !client_id) {
            return res.status(400).json({ error: 'invalid_request', error_description: 'refresh_token and client_id required' });
          }

          const tokens = await store.refreshTokens(refresh_token, client_id);
          if (!tokens) {
            return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' });
          }

          res.json(tokens);

        } else {
          res.status(400).json({ error: 'unsupported_grant_type' });
        }
      } catch (err) {
        console.error('[oauth] Token error:', err);
        res.status(500).json({ error: 'server_error', error_description: err.message });
      }
    });

    // ── Token Revocation ──

    app.post('/oauth/revoke', async (req, res) => {
      const { token } = req.body;
      if (!token) return res.status(400).json({ error: 'invalid_request' });

      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      const store = signer ? await self.getStore(domain, signer) : null;
      if (!store) return res.status(503).json({ error: 'service_unavailable' });

      try {
        await store.revokeToken(token);
        res.json({ ok: true });
      } catch {
        res.json({ ok: true });
      }
    });

    // ── Connections API (consumed by identity widget) ──

    app.get('/api/connections', async (req, res) => {
      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      if (!signer) return res.json({ inbound: [], outbound: [] });

      const store = await self.getStore(domain, signer);
      if (!store) return res.json({ inbound: [], outbound: [] });

      try {
        const consent = await store.listConsent();
        const clients = await store.listClients();
        const clientMap = {};
        for (const c of clients) clientMap[c.client_id] = c;

        const inbound = consent.map(c => ({
          id: c.id,
          type: 'inbound',
          name: clientMap[c.client_id]?.name || c.client_id,
          scope: c.scope,
          created: c.created
        }));

        const connections = await store.listConnections();
        const outbound = connections.map(c => ({
          id: c.id,
          type: c.type || 'outbound',
          name: c.name,
          service: c.service,
          created: c.created
        }));

        res.json({ inbound, outbound });
      } catch (err) {
        console.error('[oauth] List connections error:', err);
        res.json({ inbound: [], outbound: [] });
      }
    });

    // ── Revoke connection (admin only) ──

    app.delete('/api/connections/:id', async (req, res) => {
      const isAdmin = req.episteryClient && req.domainAcl
        ? await req.domainAcl.isAdmin(req.episteryClient.identityAddress)
        : false;
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });

      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      const store = signer ? await self.getStore(domain, signer) : null;
      if (!store) return res.status(503).json({ error: 'service_unavailable' });

      const id = req.params.id;
      try {
        // If this is an inbound consent, drop the connection's ACL grant first
        // (the contract is the source of truth — revoking access means removing
        // the address from the ACL, not just deleting the local record).
        const consent = (await store.listConsent()).find(c => c.id === id);
        if (consent?.wallet) await self._revokeAcl(req.domainAcl?.chain, consent.wallet);

        let removed = await store.removeConnection(id);
        if (!removed) removed = await store.revokeConsent(id);
        res.json({ ok: removed });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Cleanup expired tokens (admin only) ──

    app.post('/api/connections/cleanup', async (req, res) => {
      const isAdmin = req.episteryClient && req.domainAcl
        ? await req.domainAcl.isAdmin(req.episteryClient.identityAddress)
        : false;
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });

      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      const store = signer ? await self.getStore(domain, signer) : null;
      if (!store) return res.status(503).json({ error: 'service_unavailable' });

      try {
        const cleaned = await store.cleanupExpiredTokens();
        res.json({ ok: true, cleaned });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Revoke all connections (admin only) ──

    app.post('/api/connections/revoke-all', async (req, res) => {
      const isAdmin = req.episteryClient && req.domainAcl
        ? await req.domainAcl.isAdmin(req.episteryClient.identityAddress)
        : false;
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });

      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      const store = signer ? await self.getStore(domain, signer) : null;
      if (!store) return res.status(503).json({ error: 'service_unavailable' });

      try {
        // Drop every connection's ACL grant before clearing local state.
        const chain = req.domainAcl?.chain;
        for (const c of await store.listConsent()) {
          if (c.wallet) await self._revokeAcl(chain, c.wallet);
        }
        const result = await store.revokeAll();
        console.log(`[oauth] Revoked all: ${result.tokens} tokens, ${result.consent} consent records for ${domain}`);
        res.json({ ok: true, ...result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── Create outbound connection (admin only) ──

    app.post('/api/connections', async (req, res) => {
      const isAdmin = req.episteryClient && req.domainAcl
        ? await req.domainAcl.isAdmin(req.episteryClient.identityAddress)
        : false;
      if (!isAdmin) return res.status(403).json({ error: 'Admin access required' });

      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      const store = signer ? await self.getStore(domain, signer) : null;
      if (!store) return res.status(503).json({ error: 'service_unavailable' });

      try {
        const { service, name, credentials } = req.body;
        if (!service || !name) return res.status(400).json({ error: 'service and name required' });
        const conn = await store.addConnection({ service, name, credentials: credentials || {}, type: 'outbound' });
        res.json(conn);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    console.log('[oauth] OAuth 2.1 server routes attached');
  }

  // ── HTML Templates ──

  static _errorPage(message) {
    return `<!DOCTYPE html>
<html><head><title>OAuth Error</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a1a;color:#ccc}
.card{background:#2a2a2a;border:1px solid #444;border-radius:8px;padding:2rem;max-width:480px;text-align:center}
h2{color:#c44;margin-top:0}</style></head>
<body><div class="card"><h2>Authorization Error</h2><p>${esc(message)}</p></div></body></html>`;
  }

  static _consentPage({ client_name, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, domain, csrf_token }) {
    const scopeList = scope ? scope.split(' ').filter(Boolean) : [];
    const scopeHtml = scopeList.length > 0
      ? scopeList.map(s => `<li>${esc(s)}</li>`).join('')
      : '<li>No specific scopes requested</li>';

    return `<!DOCTYPE html>
<html><head><title>Authorize Connection</title>
<style>
body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a1a;color:#ccc}
.card{background:#2a2a2a;border:1px solid #444;border-radius:8px;padding:2rem;max-width:480px;width:100%}
h2{margin-top:0;color:#e8d5c0}
.client-name{font-size:1.2rem;font-weight:bold;color:#c89b6e}
.scopes{list-style:none;padding:0;margin:1rem 0}
.scopes li{padding:0.4rem 0;border-bottom:1px solid #333;font-size:0.9rem}
.scopes li::before{content:'\\2713 ';color:#6a6}
.redirect{font-family:monospace;font-size:0.8rem;color:#89a;word-break:break-all;background:#222;padding:0.5rem;border-radius:4px;margin:0.5rem 0}
.actions{display:flex;gap:1rem;margin-top:1.5rem}
.btn{flex:1;padding:0.75rem;border:none;border-radius:4px;cursor:pointer;font-size:1rem;font-weight:bold}
.btn-approve{background:#4a7c3f;color:#fff}
.btn-approve:hover{background:#5a9c4f}
.btn-deny{background:#555;color:#ccc}
.btn-deny:hover{background:#666}
.domain{font-size:0.85rem;color:#888;margin-bottom:1rem}
</style></head>
<body>
<div class="card">
  <h2>Authorize Connection</h2>
  <div class="domain">${esc(domain)}</div>
  <p><span class="client-name">${esc(client_name)}</span> wants to connect to your epistery domain.</p>
  <p>Requested permissions:</p>
  <ul class="scopes">${scopeHtml}</ul>
  <p style="font-size:0.85rem;color:#999">Auth code will be sent to:</p>
  <div class="redirect">${esc(redirect_uri)}</div>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${esc(client_id)}">
    <input type="hidden" name="redirect_uri" value="${esc(redirect_uri)}">
    <input type="hidden" name="scope" value="${esc(scope)}">
    <input type="hidden" name="state" value="${esc(state)}">
    <input type="hidden" name="code_challenge" value="${esc(code_challenge)}">
    <input type="hidden" name="code_challenge_method" value="${esc(code_challenge_method)}">
    <input type="hidden" name="csrf_token" value="${esc(csrf_token)}">
    <div class="actions">
      <button type="submit" name="action" value="deny" class="btn btn-deny">Deny</button>
      <button type="submit" name="action" value="approve" class="btn btn-approve">Approve</button>
    </div>
  </form>
</div>
</body></html>`;
  }
}
