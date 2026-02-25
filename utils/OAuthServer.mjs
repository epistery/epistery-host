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
 * Domain wallet = custodial identity. OAuth tokens map to Config.data.wallet.address.
 *
 * Server-to-server flow:
 *   1. AI POSTs to /oauth/authorize without admin session
 *   2. System creates pending request (same file as ACL access requests)
 *   3. Admin approves on /admin page
 *   4. AI polls GET /oauth/authorize/poll?request_id=... and gets auth code
 *   5. AI exchanges code for tokens at POST /oauth/token
 */

import crypto from 'crypto';
import { Config } from 'epistery';
import KeyManager from '../../secret-agent/key-manager.mjs';
import OAuthStore from './OAuthStore.mjs';

const SCOPES = [
  'archive:read', 'archive:write',
  'wiki:read', 'wiki:write',
  'secrets:read', 'secrets:create',
  'messages:read', 'messages:write'
];

export class OAuthServer {
  static keyManager = new KeyManager();
  static stores = new Map();

  /**
   * Get or create OAuthStore for a domain.
   * Returns null if master key not initialized.
   */
  static async getStore(domain, signer) {
    if (OAuthServer.stores.has(domain)) return OAuthServer.stores.get(domain);

    if (!OAuthServer.keyManager.hasMasterKey(domain)) return null;

    try {
      const masterKey = await OAuthServer.keyManager.getMasterKey(domain, signer);
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
   * Attach all OAuth routes and Bearer middleware to app.
   */
  static attach(app) {
    const self = OAuthServer;

    // ── Bearer Middleware ──
    app.use(async (req, res, next) => {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer rootz_at_')) return next();

      const token = auth.slice(7);
      const domain = req.hostname || 'localhost';
      const signer = self.getSigner(req);
      if (!signer) return next();

      try {
        const store = await self.getStore(domain, signer);
        if (!store) return next();

        const record = await store.validateAccessToken(token);
        if (!record) return next();

        req.episteryClient = {
          address: record.wallet,
          authenticated: true,
          authType: 'oauth'
        };
        req.oauthScope = record.scope;
      } catch (err) {
        console.error('[oauth] Bearer validation error:', err.message);
      }
      next();
    });

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
        ? await req.domainAcl.isAdmin(req.episteryClient.address)
        : false;

      if (isAdmin) {
        // Browser-based admin: serve consent page
        const requestedScope = scope || client.scope || '';
        return res.send(self._consentPage({
          client_name: client.name,
          client_id,
          redirect_uri: redirect_uri || client.redirect_uris[0],
          scope: requestedScope,
          state: state || '',
          code_challenge,
          code_challenge_method: code_challenge_method || 'S256',
          domain
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
      const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, action } = req.body;

      // Check admin auth
      const isAdmin = req.episteryClient && req.domainAcl
        ? await req.domainAcl.isAdmin(req.episteryClient.address)
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

      const walletAddress = self.getDomainWallet(domain);
      if (!walletAddress) return res.status(500).json({ error: 'server_error', error_description: 'No domain wallet' });

      try {
        await store.recordConsent({
          client_id,
          wallet: walletAddress,
          scope: scope || '',
          authorizer: req.episteryClient.address
        });

        const { code } = await store.createAuthorizationCode({
          client_id,
          redirect_uri: redir,
          scope: scope || '',
          code_challenge,
          code_challenge_method: code_challenge_method || 'S256',
          wallet: walletAddress,
          authorizer: req.episteryClient.address
        });

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
        ? await req.domainAcl.isAdmin(req.episteryClient.address)
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
        request.deniedBy = req.episteryClient.address;
        self._savePendingRequests(domain, pendingRequests);
        return res.json({ success: true, message: 'Authorization denied' });
      }

      if (action === 'approve') {
        const signer = self.getSigner(req);
        const store = signer ? await self.getStore(domain, signer) : null;
        if (!store) return res.status(503).json({ error: 'Master key not initialized' });

        const walletAddress = self.getDomainWallet(domain);
        if (!walletAddress) return res.status(500).json({ error: 'No domain wallet configured' });

        try {
          // Record consent
          await store.recordConsent({
            client_id: request.client_id,
            wallet: walletAddress,
            scope: request.scope,
            authorizer: req.episteryClient.address
          });

          // Create authorization code
          const { code } = await store.createAuthorizationCode({
            client_id: request.client_id,
            redirect_uri: request.redirect_uri,
            scope: request.scope,
            code_challenge: request.code_challenge,
            code_challenge_method: request.code_challenge_method,
            wallet: walletAddress,
            authorizer: req.episteryClient.address
          });

          // Store code on the pending request so poll can return it
          request.status = 'approved';
          request.approvedAt = new Date().toISOString();
          request.approvedBy = req.episteryClient.address;
          request.authorization_code = code;
          self._savePendingRequests(domain, pendingRequests);

          console.log(`[oauth] Authorization approved for client ${request.client_name} by ${req.episteryClient.address}`);
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

    console.log('[oauth] OAuth 2.1 server routes attached');
  }

  // ── HTML Templates ──

  static _errorPage(message) {
    return `<!DOCTYPE html>
<html><head><title>OAuth Error</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#1a1a1a;color:#ccc}
.card{background:#2a2a2a;border:1px solid #444;border-radius:8px;padding:2rem;max-width:480px;text-align:center}
h2{color:#c44;margin-top:0}</style></head>
<body><div class="card"><h2>Authorization Error</h2><p>${message}</p></div></body></html>`;
  }

  static _consentPage({ client_name, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, domain }) {
    const scopeList = scope ? scope.split(' ').filter(Boolean) : [];
    const scopeHtml = scopeList.length > 0
      ? scopeList.map(s => `<li>${s}</li>`).join('')
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
  <div class="domain">${domain}</div>
  <p><span class="client-name">${client_name}</span> wants to connect to your epistery domain.</p>
  <p>Requested permissions:</p>
  <ul class="scopes">${scopeHtml}</ul>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${client_id}">
    <input type="hidden" name="redirect_uri" value="${redirect_uri}">
    <input type="hidden" name="scope" value="${scope}">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="code_challenge" value="${code_challenge}">
    <input type="hidden" name="code_challenge_method" value="${code_challenge_method}">
    <div class="actions">
      <button type="submit" name="action" value="deny" class="btn btn-deny">Deny</button>
      <button type="submit" name="action" value="approve" class="btn btn-approve">Approve</button>
    </div>
  </form>
</div>
</body></html>`;
  }
}
