/**
 * PeerBridge — Host-to-host bridge for epistery.
 *
 * Enables agents on one epistery host to be used from another.
 * The local host connects OUTWARD to the remote host via WebSocket,
 * avoiding firewall/NAT issues (reverse-connection pattern from rootz-v6).
 *
 * Every host can be both server (accept inbound peer connections) and
 * client (connect outward to remote peers) simultaneously.
 *
 * Server role:
 *   - Listens on /bridge/ws via HTTP upgrade
 *   - Authenticates with OAuth Bearer token
 *   - Receives announce-tools, registers them as external tools
 *   - Proxies tool-call → tool-result through the WebSocket
 *
 * Client role:
 *   - Reads outbound bridge connections from OAuthStore
 *   - Opens WebSocket to wss://remote-host/bridge/ws?token=<bearer>
 *   - Sends announce-tools with local tool registry
 *   - Executes incoming tool-call requests locally, returns results
 *   - Auto-reconnects with exponential backoff
 *
 * WebSocket protocol:
 *   { type: 'auth',           token }
 *   { type: 'auth-ok' }
 *   { type: 'auth-error',     error }
 *   { type: 'announce-tools', tools }
 *   { type: 'tool-call',      id, name, args }
 *   { type: 'tool-result',    id, result }
 *   { type: 'tool-error',     id, error }
 *   { type: 'ping' } / { type: 'pong' }
 */

import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';

const REQUEST_TIMEOUT_MS = 120_000;  // 2 minutes (matches rootz-v6)
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60_000;

export class PeerBridge {
  /**
   * @param {import('./AgentManager.mjs').AgentManager} agentManager
   * @param {object} opts
   * @param {number} opts.port - local HTTP port for internal tool proxying
   * @param {function} opts.getStore - async (domain) => OAuthStore|null
   * @param {function} opts.getSigner - () => signer|null
   */
  constructor(agentManager, opts = {}) {
    this.agentManager = agentManager;
    this.port = opts.port || parseInt(process.env.PORT || 4080);
    this.getStore = opts.getStore;    // async (domain) => OAuthStore
    this.getSigner = opts.getSigner;  // () => signer

    // Server side: connected inbound peers
    // Map<peerId, { ws, tools, pendingRequests, pingInterval }>
    this.inboundPeers = new Map();

    // Client side: outbound connections
    // Map<connectionId, { ws, config, reconnectDelay, reconnectTimer, pingInterval }>
    this.outboundPeers = new Map();

    this.wss = null;
    this._closing = false;
  }

  // ────────────────────────────────────────────
  // Server role — accept inbound peer connections
  // ────────────────────────────────────────────

  /**
   * Attach WebSocket upgrade handler to an HTTP server.
   * Follows the noServer pattern (same as rootz-v6 handler.ts).
   */
  initWebSocketServer(httpServer) {
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on('connection', (ws, req) => this._handleInboundConnection(ws, req));
    }

    httpServer.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      if (url.pathname === '/bridge/ws') {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      }
      // Don't destroy socket — other upgrade handlers (agents) may claim it
    });

    console.log('[bridge] WebSocket server listening on /bridge/ws');
  }

  /**
   * Handle a new inbound peer WebSocket connection.
   */
  async _handleInboundConnection(ws, req) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    const domain = req.headers.host?.split(':')[0] || 'localhost';

    console.log(`[bridge] Inbound connection from ${req.socket.remoteAddress}`);

    // Authenticate via Bearer token
    if (!token) {
      this._send(ws, { type: 'auth-error', error: { message: 'Token required as query param' } });
      ws.close();
      return;
    }

    let record;
    try {
      const signer = this.getSigner?.();
      const { OAuthServer } = await import('./OAuthServer.mjs');
      const store = await OAuthServer.getStore(domain, signer);
      if (!store) throw new Error('OAuth store unavailable');
      record = await store.validateAccessToken(token);
      if (!record) throw new Error('Invalid or expired token');
    } catch (err) {
      console.error('[bridge] Auth failed:', err.message);
      this._send(ws, { type: 'auth-error', error: { message: err.message } });
      ws.close();
      return;
    }

    const peerId = `inbound-${record.client_id || record.wallet}-${Date.now()}`;
    console.log(`[bridge] Peer authenticated: ${peerId}`);
    this._send(ws, { type: 'auth-ok' });

    const peer = {
      ws,
      peerId,
      wallet: record.wallet,
      tools: [],
      pendingRequests: new Map(),
      pingInterval: setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          this._send(ws, { type: 'ping' });
        }
      }, PING_INTERVAL_MS)
    };

    this.inboundPeers.set(peerId, peer);

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleInboundMessage(peerId, msg);
      } catch (err) {
        console.error('[bridge] Invalid message from peer:', err.message);
      }
    });

    ws.on('close', () => {
      console.log(`[bridge] Inbound peer disconnected: ${peerId}`);
      this._cleanupInboundPeer(peerId);
    });

    ws.on('error', (err) => {
      console.error(`[bridge] Inbound peer error (${peerId}):`, err.message);
    });
  }

  /**
   * Handle message from an inbound peer.
   */
  _handleInboundMessage(peerId, msg) {
    const peer = this.inboundPeers.get(peerId);
    if (!peer) return;

    switch (msg.type) {
      case 'announce-tools':
        this._handleAnnounceTools(peerId, msg.tools || []);
        break;

      case 'tool-result':
      case 'tool-error':
        this._handleToolResponse(peerId, msg);
        break;

      case 'pong':
        // keep-alive acknowledged
        break;

      default:
        console.log(`[bridge] Unknown message type from ${peerId}: ${msg.type}`);
    }
  }

  /**
   * Peer announced its available tools. Register them as external tools.
   */
  _handleAnnounceTools(peerId, tools) {
    const peer = this.inboundPeers.get(peerId);
    if (!peer) return;

    peer.tools = tools;
    console.log(`[bridge] Peer ${peerId} announced ${tools.length} tool(s)`);

    // Register in AgentManager
    this.agentManager.registerExternalTools(tools, peerId);
  }

  /**
   * Handle tool-result or tool-error from a peer (response to our tool-call).
   */
  _handleToolResponse(peerId, msg) {
    const peer = this.inboundPeers.get(peerId);
    if (!peer) return;

    const pending = peer.pendingRequests.get(msg.id);
    if (!pending) {
      console.error(`[bridge] Response for unknown request ${msg.id} from ${peerId}`);
      return;
    }

    clearTimeout(pending.timeout);
    peer.pendingRequests.delete(msg.id);

    if (msg.type === 'tool-error') {
      pending.reject(new Error(msg.error?.message || 'Remote tool error'));
    } else {
      pending.resolve(msg.result);
    }
  }

  /**
   * Call a tool on an inbound peer. Used by Mimi/agents to invoke bridged tools.
   * Returns a Promise that resolves with the tool result.
   */
  callRemoteTool(peerId, toolName, args) {
    return new Promise((resolve, reject) => {
      const peer = this.inboundPeers.get(peerId);
      if (!peer || peer.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(`Peer ${peerId} not connected`));
      }

      const id = crypto.randomUUID();

      const timeout = setTimeout(() => {
        peer.pendingRequests.delete(id);
        reject(new Error(`Tool call ${toolName} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      peer.pendingRequests.set(id, { resolve, reject, timeout });

      this._send(peer.ws, {
        type: 'tool-call',
        id,
        name: toolName,
        args: args || {}
      });
    });
  }

  /**
   * Clean up disconnected inbound peer.
   */
  _cleanupInboundPeer(peerId) {
    const peer = this.inboundPeers.get(peerId);
    if (!peer) return;

    clearInterval(peer.pingInterval);

    // Reject all pending requests
    for (const [id, pending] of peer.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Peer disconnected'));
    }
    peer.pendingRequests.clear();

    // Unregister external tools
    this.agentManager.unregisterExternalTools(peerId);

    this.inboundPeers.delete(peerId);
  }

  // ────────────────────────────────────────────
  // Client role — connect outward to remote peers
  // ────────────────────────────────────────────

  /**
   * Connect to all configured bridge peers.
   * Reads connections with service='epistery-bridge' from OAuthStore.
   */
  async connectToConfiguredPeers(domain) {
    if (!this.getStore) {
      console.log('[bridge] No getStore provided, skipping outbound connections');
      return;
    }

    try {
      const store = await this.getStore(domain);
      if (!store) {
        console.log('[bridge] No OAuth store available, skipping outbound connections');
        return;
      }

      const connections = await store.listConnections();
      const bridgeConnections = [];

      for (const meta of connections) {
        const full = await store.getConnection(meta.id);
        if (full && full.service === 'epistery-bridge') {
          bridgeConnections.push(full);
        }
      }

      if (bridgeConnections.length === 0) {
        console.log('[bridge] No outbound bridge connections configured');
        return;
      }

      console.log(`[bridge] Connecting to ${bridgeConnections.length} peer(s)...`);
      for (const conn of bridgeConnections) {
        this.connectToPeer(conn);
      }
    } catch (err) {
      console.error('[bridge] Error loading outbound connections:', err.message);
    }
  }

  /**
   * Connect outward to a single remote peer host.
   * @param {object} connectionConfig - { id, credentials: { url, access_token } }
   */
  connectToPeer(connectionConfig) {
    const connId = connectionConfig.id;
    const { url: remoteUrl, access_token } = connectionConfig.credentials || {};

    if (!remoteUrl || !access_token) {
      console.error(`[bridge] Connection ${connId} missing url or access_token`);
      return;
    }

    // Build WebSocket URL
    const wsUrl = remoteUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')
      .replace(/\/$/, '') + `/bridge/ws?token=${encodeURIComponent(access_token)}`;

    const peerState = {
      config: connectionConfig,
      ws: null,
      reconnectDelay: RECONNECT_BASE_MS,
      reconnectTimer: null,
      pingInterval: null
    };

    this.outboundPeers.set(connId, peerState);
    this._connectOutbound(connId, wsUrl);
  }

  /**
   * Internal: establish outbound WebSocket connection.
   */
  _connectOutbound(connId, wsUrl) {
    if (this._closing) return;

    const peerState = this.outboundPeers.get(connId);
    if (!peerState) return;

    console.log(`[bridge] Connecting to peer ${connId}...`);

    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error(`[bridge] Failed to create WebSocket for ${connId}:`, err.message);
      this._scheduleReconnect(connId, wsUrl);
      return;
    }

    peerState.ws = ws;

    ws.on('open', () => {
      console.log(`[bridge] Connected to peer ${connId}`);
      peerState.reconnectDelay = RECONNECT_BASE_MS; // reset backoff

      // Start ping/pong keep-alive
      peerState.pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          this._send(ws, { type: 'ping' });
        }
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleOutboundMessage(connId, msg);
      } catch (err) {
        console.error(`[bridge] Invalid message from remote ${connId}:`, err.message);
      }
    });

    ws.on('close', () => {
      console.log(`[bridge] Disconnected from peer ${connId}`);
      this._cleanupOutbound(connId);
      this._scheduleReconnect(connId, wsUrl);
    });

    ws.on('error', (err) => {
      console.error(`[bridge] Outbound error (${connId}):`, err.message);
    });
  }

  /**
   * Handle message from a remote host (client role).
   */
  _handleOutboundMessage(connId, msg) {
    switch (msg.type) {
      case 'auth-ok':
        console.log(`[bridge] Auth OK from peer ${connId}, announcing tools`);
        this._announceLocalTools(connId);
        break;

      case 'auth-error':
        console.error(`[bridge] Auth rejected by peer ${connId}: ${msg.error?.message}`);
        // Don't reconnect on auth errors — token is bad
        const peerState = this.outboundPeers.get(connId);
        if (peerState) {
          clearTimeout(peerState.reconnectTimer);
          peerState.reconnectTimer = null;
        }
        break;

      case 'tool-call':
        this._handleRemoteToolCall(connId, msg);
        break;

      case 'ping':
        this._sendToOutbound(connId, { type: 'pong' });
        break;

      case 'pong':
        // keep-alive acknowledged
        break;

      default:
        console.log(`[bridge] Unknown message from remote ${connId}: ${msg.type}`);
    }
  }

  /**
   * Send our local tool registry to the remote host.
   */
  _announceLocalTools(connId) {
    // Send only local tools (not bridged ones — avoid loops)
    const localTools = this.agentManager.toolRegistry.map(t => ({
      name: t.name,
      description: t.description,
      method: t.method,
      basePath: t.basePath,
      path: t.path,
      inputSchema: t.inputSchema
    }));

    this._sendToOutbound(connId, {
      type: 'announce-tools',
      tools: localTools
    });

    console.log(`[bridge] Announced ${localTools.length} local tool(s) to peer ${connId}`);
  }

  /**
   * Handle a tool-call from the remote host. Execute locally and return result.
   */
  async _handleRemoteToolCall(connId, msg) {
    const { id, name, args } = msg;

    console.log(`[bridge] Remote tool call: ${name} (id: ${id})`);

    try {
      // Execute via local HTTP (same pattern as Mimi's proxyToolCall)
      const result = await this._executeLocalTool(name, args || {});
      this._sendToOutbound(connId, { type: 'tool-result', id, result });
    } catch (err) {
      console.error(`[bridge] Tool ${name} failed:`, err.message);
      this._sendToOutbound(connId, {
        type: 'tool-error',
        id,
        error: { message: err.message }
      });
    }
  }

  /**
   * Execute a tool locally via internal HTTP request.
   * Mirrors Mimi's proxyToolCall default-case logic for agent tools.
   */
  async _executeLocalTool(toolName, args) {
    const tool = this.agentManager.toolRegistry.find(t => t.name === toolName);
    if (!tool) {
      throw new Error(`Unknown tool: ${toolName}`);
    }

    // Substitute {param} placeholders in path
    let toolPath = tool.path.replace(/\{(\w+)\}/g, (_, key) =>
      encodeURIComponent(args[key] || '')
    );
    const fullPath = `${tool.basePath}${toolPath}`;
    const baseUrl = `http://127.0.0.1:${this.port}`;

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    let url;
    let fetchOpts = { headers };

    if (tool.method === 'GET') {
      // Remaining args (not consumed by path) become query params
      const pathParams = new Set(
        (tool.path.match(/\{(\w+)\}/g) || []).map(p => p.slice(1, -1))
      );
      const queryArgs = Object.entries(args).filter(
        ([k]) => !pathParams.has(k) && args[k] != null
      );
      const qs = queryArgs.length ? '?' + new URLSearchParams(queryArgs).toString() : '';
      url = `${baseUrl}${fullPath}${qs}`;
    } else {
      url = `${baseUrl}${fullPath}`;
      fetchOpts.method = tool.method;
      fetchOpts.body = JSON.stringify(args);
    }

    const res = await fetch(url, fetchOpts);
    return await res.json();
  }

  /**
   * Schedule reconnect with exponential backoff.
   */
  _scheduleReconnect(connId, wsUrl) {
    if (this._closing) return;

    const peerState = this.outboundPeers.get(connId);
    if (!peerState) return;

    const delay = peerState.reconnectDelay;
    peerState.reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);

    console.log(`[bridge] Reconnecting to ${connId} in ${delay}ms...`);
    peerState.reconnectTimer = setTimeout(() => {
      this._connectOutbound(connId, wsUrl);
    }, delay);
  }

  /**
   * Clean up outbound connection state (but keep config for reconnect).
   */
  _cleanupOutbound(connId) {
    const peerState = this.outboundPeers.get(connId);
    if (!peerState) return;

    if (peerState.pingInterval) {
      clearInterval(peerState.pingInterval);
      peerState.pingInterval = null;
    }
    peerState.ws = null;
  }

  // ────────────────────────────────────────────
  // Helpers
  // ────────────────────────────────────────────

  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  _sendToOutbound(connId, msg) {
    const peerState = this.outboundPeers.get(connId);
    if (peerState?.ws) {
      this._send(peerState.ws, msg);
    }
  }

  /**
   * Clean up all connections on shutdown.
   */
  cleanup() {
    this._closing = true;

    // Close inbound peers
    for (const [peerId] of this.inboundPeers) {
      this._cleanupInboundPeer(peerId);
    }

    // Close outbound peers
    for (const [connId, peerState] of this.outboundPeers) {
      if (peerState.reconnectTimer) clearTimeout(peerState.reconnectTimer);
      if (peerState.pingInterval) clearInterval(peerState.pingInterval);
      if (peerState.ws) peerState.ws.close();
    }
    this.outboundPeers.clear();

    if (this.wss) {
      this.wss.close();
    }

    console.log('[bridge] All peer connections closed');
  }
}
