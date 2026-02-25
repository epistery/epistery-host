# Epistery Host Architecture

Epistery-host is a hosted application server that turns any domain into an epistery node. It builds on the `epistery` middleware for identity and wallet management, then layers on domain administration, OAuth 2.1, MCP (Model Context Protocol), and a pluggable agent system.

## Middleware Stack

The mount order in `index.mjs` is critical. Each layer depends on what precedes it:

```
Express app
  ├── CORS, body parsing, cookie parser
  ├── Authentication router (/account/claim, /claim)
  ├── Static files (/style, /image, /script, /widgets)
  ├── Epistery middleware (attach at '/')
  │     └── sets req.episteryClient (address, authenticated, authType)
  ├── DomainAcl.attach(app)
  │     └── sets req.domainAcl (isAdmin, checkAgentAccess)
  ├── OAuthServer.attach(app)
  │     ├── Bearer middleware (validates rootz_at_* tokens)
  │     ├── Well-known endpoints
  │     ├── OAuth endpoints (/oauth/*)
  │     └── Connections API (/api/connections)
  ├── MCPServer.attach(app)
  │     └── JSON-RPC at /mcp (POST, GET SSE, DELETE)
  ├── Pages (template frames)
  └── AgentManager.loadAll(app)
        └── Each agent at /agent/{namespace}/{name}/*
```

The epistery middleware provides `req.episteryClient` — the authenticated identity from browser wallets (TPM-backed keys in localStorage) or from OAuth Bearer tokens. DomainAcl reads the DomainAgent smart contract to resolve ACL lists (admin, editor, reader). OAuthServer's Bearer middleware extends `req.episteryClient` for OAuth-authenticated requests. Everything downstream — MCP, agents, API routes — inherits this identity chain.

## Domain Lifecycle

A domain progresses through three states:

1. **Unclaimed** — epistery-host serves the claim page. The admin-to-be provides their wallet address. A DNS TXT challenge is generated.
2. **Claimed (no contract)** — DNS verified, domain config at `~/.epistery/{domain}/config.json` stores wallet and admin address. The initialize page offers DomainAgent contract deployment.
3. **Initialized** — DomainAgent contract deployed on Polygon. ACL lists managed on-chain. Full agent and OAuth functionality available.

Domain configuration lives at `~/.epistery/{domain}/config.json` managed by the `Config` class from the epistery npm package. The server wallet (mnemonic-derived) is created during domain setup and stored in this config.

## Identity Model

Epistery uses blockchain addresses as identity, with no accounts or passwords.

**Browser identity**: The epistery middleware mints an unexportable private key via the Web Crypto API (backed by TPM on supporting hardware). This key is stored in the browser and produces a stable wallet address. Users can also connect Web3 wallets (MetaMask, Trezor) for cross-device identity.

**Server identity**: Each domain has a server wallet (mnemonic in config). This wallet owns the DomainAgent contract and signs blockchain transactions.

**OAuth identity**: When AI agents connect via OAuth, the Bearer middleware maps their token to the domain wallet address. The AI operates with the domain's identity, scoped by the OAuth grants.

## OAuth 2.1 Server (OAuthServer.mjs)

Core infrastructure mounted directly in `index.mjs`, not via an agent. Implements:

- **RFC 8414** — `GET /.well-known/oauth-authorization-server` metadata
- **RFC 9728** — `GET /.well-known/oauth-protected-resource` metadata
- **RFC 7591** — `POST /oauth/register` dynamic client registration (rate-limited, 10/IP/hour)
- **Authorization** — `GET /oauth/authorize` (consent page or pending request), `POST /oauth/authorize` (process consent)
- **Token exchange** — `POST /oauth/token` (auth code + PKCE S256, refresh token)
- **Token revocation** — `POST /oauth/revoke`
- **Async approval** — `GET /oauth/authorize/poll` and `POST /oauth/handle-request` for server-to-server flows where no admin browser session is present

Two authorization flows:

1. **Browser-based**: Admin is logged in (has `req.episteryClient` and passes `isAdmin` check). They see a consent page with client name, requested scopes, and redirect URI. CSRF-protected. Approving creates an auth code immediately and redirects.

2. **Server-to-server**: No admin session present. A pending request is created (stored in `pending-requests.json`). The AI agent polls `/oauth/authorize/poll?request_id=...` until an admin approves via the admin panel.

**Bearer middleware** runs on every request. If `Authorization: Bearer rootz_at_...` is present, it validates the token against OAuthStore and sets `req.episteryClient = { address: domainWallet, authenticated: true, authType: 'oauth' }` and `req.oauthScope`.

**Scopes**: `archive:read`, `archive:write`, `wiki:read`, `wiki:write`, `secrets:read`, `secrets:create`, `messages:read`, `messages:write`.

**Connections API**: `GET /api/connections` lists inbound (OAuth consents) and outbound connections. `DELETE /api/connections/:id` revokes a connection (admin only). Consumed by the identity widget on the home page.

## MCP Server (MCPServer.mjs)

Implements the Model Context Protocol (JSON-RPC 2.0 over Streamable HTTP) at `/mcp`. This is how AI assistants (Claude, etc.) interact with epistery services after OAuth authentication.

Endpoints:
- `POST /mcp` — JSON-RPC requests (initialize, tools/list, tools/call, ping, resources/list, prompts/list)
- `GET /mcp` — SSE stream with keep-alive (for clients that open GET first)
- `DELETE /mcp` — Session cleanup

Protocol negotiation supports versions `2024-11-05` and `2025-03-26`.

Requires OAuth authentication. Unauthenticated requests receive 401 with `WWW-Authenticate` header pointing to the protected resource metadata, triggering the OAuth discovery flow.

### MCP Tools (MCPTools.mjs)

Each tool proxies to an internal epistery agent via HTTP on loopback (`127.0.0.1:{port}`). The Host header is forwarded for domain routing but the connection never leaves the machine.

Tools:
- **wiki_read**, **wiki_write**, **wiki_list** — Wiki agent CRUD
- **archive_create**, **archive_list**, **archive_search**, **archive_read**, **archive_stats** — Archive agent
- **message_list**, **message_post** — Message board agent
- **secret_list** — Secret agent (metadata only)
- **whoami** — Current identity info

Each tool has an assigned scope in `TOOL_SCOPES`. The MCP server enforces scope before dispatching any tool call.

## Encrypted Storage

Agents that store sensitive data use a layered storage system:

```
StorageFactory.create(null, domain, agentName)
  └── Returns a storage backend (filesystem at ~/.epistery/{domain}/{agentName}/)

EncryptedStorage(storage, masterKey)
  └── Wraps any storage backend with AES-256-GCM encryption
```

**Master key lifecycle** (`secret-agent/key-manager.mjs`):
1. `initMasterKey(domain, signer)` — generates a random 256-bit key, encrypts it with a message signed by the domain wallet, stores at `~/.epistery/{domain}/secret-agent/master-key.json`
2. `getMasterKey(domain, signer)` — re-derives the signature, decrypts the master key
3. The master key never appears in plaintext on disk

OAuthServer auto-initializes the master key on first use if the signer is available. This means OAuth works without manual setup after domain initialization.

**Crypto primitives** (`utils/crypto/`):
- `aes.mjs` — AES-256-GCM encrypt/decrypt
- `master-key.mjs` — Signature-based key wrapping
- `ecdh.mjs` — Elliptic curve Diffie-Hellman for key agreement
- `utils.mjs` — Hex/buffer conversion helpers

## OAuthStore (OAuthStore.mjs)

Encrypted storage for all OAuth entities. Follows the SecretStore pattern:

```
~/.epistery/{domain}/oauth-agent/
  ├── clients/index.json          — registered clients (plaintext metadata)
  ├── clients/{id}.json           — client details (encrypted)
  ├── codes/{hash}.json           — authorization codes (encrypted, 5 min expiry)
  ├── tokens/index.json           — active tokens metadata
  ├── tokens/{hash}.json          — token records (encrypted)
  ├── consent/index.json          — consent records metadata
  ├── consent/{id}.json           — consent with authorizer (encrypted)
  ├── connections/index.json      — outbound connections metadata
  └── connections/{id}.json       — outbound credentials (encrypted)
```

Token format: `rootz_at_` (access, 1 hour) and `rootz_rt_` (refresh, 30 days) prefixed opaque tokens. Stored as SHA-256 hashes. PKCE uses S256 (SHA-256 of code_verifier compared to code_challenge).

## Agent System (AgentManager.mjs)

Agents are modular services discovered from `~/.epistery/.agents/`. Each agent is a directory (or symlink) containing:

- `epistery.json` — manifest with name, version, title, icon, main entry, permissions
- `index.mjs` — default export is a class with `attach(router)` and optional `cleanup()`, `initWebSocket(server)`

AgentManager mounts each agent at two equivalent paths:
- `/.well-known/epistery/agent/{namespace}/{name}/*`
- `/agent/{namespace}/{name}/*`

where `{namespace}/{name}` derives from the npm package name (e.g., `@epistery/wiki` becomes `epistery/wiki`).

Features:
- **Hot reload**: Agents with `.git` directories get a `/_update` endpoint that pulls latest code and rebuilds the router without restarting the server
- **WebSocket support**: Agents implementing `initWebSocket(server)` get WebSocket connections on both HTTP and HTTPS servers
- **Router proxy**: A proxy function delegates to `agentData.activeRouter`, allowing hot-swap without re-mounting Express routes

## Widget System

The home page uses a widget architecture for composability:

1. `index.html` contains `<div data-widget="identity"></div>` and `<div data-widget="agent-cards"></div>` elements
2. `common.js` loads the epistery witness (client identity), then `widgets.mjs` scans for `data-widget` attributes
3. Each widget fetches its HTML from `/widgets/{name}.html` and injects it into the DOM
4. Embedded `<script>` tags in widget HTML are re-executed after injection

Current widgets:
- **header.html** — floating nav bar (position:fixed top-left) with dropdown menu from `/api/nav-menu`
- **identity.html** — server info, wallet list (browser + Web3), connections section (from `/api/connections`)
- **agent-cards.html** — service cards from `/api/agents`

The home page layout is a two-column flex: identity (flex:2) on the left, agent-cards (flex:1) on the right.

## DomainAcl (DomainAcl.mjs)

Middleware that bridges the DomainAgent smart contract's ACL system into Express:

- `req.domainAcl.isAdmin(address)` — checks `epistery::admin` list on-chain (falls back to `config.admin_address` if no contract)
- `req.domainAcl.checkAgentAccess(agentName, address, domain)` — evaluates per-agent ACL stance from contract public attributes
- ACL routes: `/api/acl/check-admin`, `/api/acl/list/:listName`, `/api/acl/agent/:agent`, add/remove/update members, request-access flow

ACL lists are stored on the Polygon blockchain via the DomainAgent contract. Standard lists: `epistery::admin` (level 3), `epistery::editor` (level 2), `epistery::reader` (level 1), `default` (level 0). Each agent can have its own ACL stance stored as a JSON public attribute on the contract.

## Security Model

- **PKCE (S256)** required for all OAuth authorization flows
- **CSRF tokens** (single-use, 10-minute expiry) protect the consent form
- **Rate limiting** on client registration (10 registrations per IP per hour)
- **HTML escaping** (`esc()` helper) prevents XSS in consent and error pages
- **Scope enforcement** — every MCP tool call checked against `TOOL_SCOPES` before execution
- **Loopback proxy** — MCP tool handlers connect to `127.0.0.1` only, preventing SSRF via Host header manipulation
- **Encrypted storage** — OAuth tokens, client secrets, and consent records encrypted at rest with AES-256-GCM
- **Master key derivation** — master key encrypted with a domain wallet signature, never stored in plaintext

## File Map

```
epistery-host/
  ├── index.mjs                          — Main app, middleware stack, API routes
  ├── utils/
  │     ├── authentication.mjs           — Domain claim flow (DNS TXT challenge)
  │     ├── DomainAcl.mjs                — ACL middleware + routes
  │     ├── DomainChain.mjs              — DomainAgent contract interface
  │     ├── AgentManager.mjs             — Agent discovery, loading, hot-reload
  │     ├── OAuthServer.mjs              — OAuth 2.1 server + Bearer middleware
  │     ├── OAuthStore.mjs               — Encrypted OAuth entity storage
  │     ├── MCPServer.mjs                — MCP JSON-RPC server
  │     ├── MCPTools.mjs                 — MCP tool definitions + scope enforcement
  │     ├── crypto/
  │     │     ├── aes.mjs                — AES-256-GCM
  │     │     ├── master-key.mjs         — Signature-based key wrapping
  │     │     ├── ecdh.mjs               — ECDH key agreement
  │     │     └── utils.mjs              — Buffer/hex helpers
  │     └── storage/
  │           ├── StorageFactory.mjs     — Storage backend factory
  │           ├── EncryptedStorage.mjs   — Transparent encryption wrapper
  │           └── StorjStorage.mjs       — Storj backend (alternative)
  ├── public/
  │     ├── index.html                   — Home page shell
  │     ├── claim.html                   — Domain claim page
  │     ├── initialize.html              — Contract deployment page
  │     ├── admin.html                   — Admin panel
  │     ├── devtools.html                — Developer diagnostics
  │     ├── script/
  │     │     ├── common.js              — Witness loader + widget init
  │     │     └── widgets.mjs            — Widget loader class
  │     ├── widgets/
  │     │     ├── header.html            — Navigation widget
  │     │     ├── identity.html          — Identity + connections widget
  │     │     └── agent-cards.html       — Agent service cards widget
  │     └── style/                       — CSS + Entypo icon font
  ├── pages/                             — Template page frames
  ├── contracts/                         — DomainAgent.sol source
  └── artifacts/                         — Compiled contract ABI + bytecode
```

## Dependencies

- `epistery` — Core middleware (identity, wallet, Config, witness)
- `express` — HTTP framework
- `ethers` (v5) — Ethereum/Polygon interactions
- `@metric-im/administrate` — TLS certificate management (Certify)
- `secret-agent/key-manager.mjs` — Shared master key lifecycle (imported by OAuthServer)
