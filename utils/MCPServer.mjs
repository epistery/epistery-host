/**
 * MCPServer — Root MCP protocol infrastructure for epistery-host.
 *
 * Mounts directly in index.mjs via MCPServer.attach(app), same pattern as OAuthServer.
 * Implements MCP JSON-RPC 2.0 over Streamable HTTP transport.
 *
 * Endpoints:
 *   POST /mcp   — JSON-RPC requests (initialize, tools/list, tools/call, ping)
 *   GET  /mcp   — SSE stream (keep-alive for clients that open GET first)
 *   DELETE /mcp  — Session cleanup
 *
 * Auth: requires req.episteryClient (set by epistery middleware or OAuthServer).
 * Accepts both OAuth Bearer tokens and epistery bot-auth (ECDSA signatures).
 * Returns 401 with WWW-Authenticate for unauthenticated requests.
 *
 * Agent tools from epistery.json manifests are automatically included in tools/list
 * and proxied in tools/call. Agents can implement describeTools(domain) to provide
 * dynamic tool descriptions (e.g. horoscope profiles baked into the description).
 *
 * Adapted from Steven's /opt/mcp-agent/index.mjs.
 */

import { Config } from 'epistery';
import { TOOLS, createHandlers } from './MCPTools.mjs';
import { OAuthServer } from './OAuthServer.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'epistery', version: '0.1.0' };

// Coarse permission tiers (mirrors epistery.app/lib/mcp.mjs). A tool declares
// a `scope`; the caller carries a `role`. read < edit < admin. Fine-grained
// OAuth scope strings (e.g. 'wiki:write') collapse to a tier; unknown/no scope
// is unrestricted (any role with MCP access may call).
const TIER_RANK = { read: 1, edit: 2, admin: 3 };

function scopeRequiredTier(scope) {
  if (!scope) return 0;                       // unrestricted
  if (/:admin$/.test(scope)) return 3;
  if (/:(write|create)$/.test(scope)) return 2;
  return 1;                                   // :read and anything else → read
}

function roleAllows(role, scope) {
  const need = scopeRequiredTier(scope);
  if (!need) return true;
  return (TIER_RANK[role] || 0) >= need;
}

export class MCPServer {
  static handlers = null;
  static _app = null;
  static _port = null;

  static attach(app) {
    const port = parseInt(process.env.PORT || 4080);
    MCPServer._app = app;
    MCPServer._port = port;
    MCPServer.handlers = createHandlers(port);

    // ── POST /mcp — JSON-RPC requests ──
    app.post('/mcp', async (req, res) => {
      // Resolve the calling principal to { caller, role }. Two credentials are
      // accepted: a proven epistery identity (cookie/bot, via req.episteryClient)
      // OR an OAuth bearer (resolved to the connection's derived address). The
      // role is read from the contract ACL (the source of truth) for the caller.
      // A null principal or a caller with no ACL role gets no MCP access.
      const principal = await MCPServer._resolvePrincipal(req);
      if (!principal || !principal.role) {
        return res.status(401)
          .set('WWW-Authenticate', `Bearer resource_metadata="https://${req.hostname}/.well-known/oauth-protected-resource"`)
          .json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Authentication required.' },
            id: null
          });
      }

      const body = req.body;

      // Handle JSON-RPC batch
      if (Array.isArray(body)) {
        const results = [];
        for (const msg of body) {
          const result = await MCPServer._dispatch(msg, req, principal);
          if (result !== null) results.push(result);
        }
        if (results.length === 0) return res.status(204).end();
        return res.json(results);
      }

      // Handle single JSON-RPC message
      const result = await MCPServer._dispatch(body, req, principal);
      if (result === null) {
        res.status(204).end();
      } else {
        res.json(result);
      }
    });

    // ── GET /mcp — SSE stream ──
    // Some MCP clients (Claude Code) open a GET SSE connection first.
    app.get('/mcp', async (req, res) => {
      const principal = await MCPServer._resolvePrincipal(req);
      if (!principal || !principal.role) {
        return res.status(401)
          .set('WWW-Authenticate', `Bearer resource_metadata="https://${req.hostname}/.well-known/oauth-protected-resource"`)
          .json({ error: 'Authentication required' });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

      // Initial endpoint event
      res.write(`event: endpoint\ndata: /mcp\n\n`);

      // Keep-alive ping every 30s
      const keepAlive = setInterval(() => {
        res.write(`: ping\n\n`);
      }, 30000);

      req.on('close', () => {
        clearInterval(keepAlive);
      });
    });

    // ── DELETE /mcp — Session cleanup ──
    app.delete('/mcp', (req, res) => {
      res.status(200).json({ ok: true });
    });

    console.log('[mcp] MCP server routes attached (POST/GET/DELETE /mcp)');
  }

  // ── JSON-RPC Dispatcher ──

  static async _dispatch(msg, req, principal) {
    if (!msg || msg.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request: missing jsonrpc 2.0' },
        id: msg?.id || null
      };
    }

    const isNotification = msg.id === undefined || msg.id === null;

    switch (msg.method) {
      case 'initialize':
        return MCPServer._handleInitialize(msg);

      case 'notifications/initialized':
        return null;

      case 'tools/list': {
        // Only advertise tools the caller's role can actually invoke — cleaner
        // for the client than surfacing tools that 403 mid-call.
        const all = await MCPServer._getAllTools(req);
        const tools = all.filter(t => roleAllows(principal.role, t._agent?.scope))
          .map(({ _agent, ...t }) => t);   // strip internal routing from the wire
        return { jsonrpc: '2.0', id: msg.id, result: { tools } };
      }

      case 'tools/call':
        return await MCPServer._handleCallTool(msg, req, principal);

      case 'ping':
        return { jsonrpc: '2.0', id: msg.id, result: {} };

      case 'resources/list':
        return { jsonrpc: '2.0', id: msg.id, result: { resources: [] } };

      case 'prompts/list':
        return { jsonrpc: '2.0', id: msg.id, result: { prompts: [] } };

      default:
        if (isNotification) return null;
        return {
          jsonrpc: '2.0',
          error: { code: -32601, message: `Method not found: ${msg.method}` },
          id: msg.id
        };
    }
  }

  static _handleInitialize(msg) {
    const clientVersion = msg.params?.protocolVersion;
    const negotiatedVersion = ['2024-11-05', '2025-03-26'].includes(clientVersion)
      ? clientVersion
      : PROTOCOL_VERSION;

    return {
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: negotiatedVersion,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: SERVER_INFO
      }
    };
  }

  static async _handleCallTool(msg, req, principal) {
    const { name, arguments: args } = msg.params || {};

    if (!name) {
      return {
        jsonrpc: '2.0',
        error: { code: -32602, message: 'Invalid params: missing tool name' },
        id: msg.id
      };
    }

    // Check static handlers first (host-level tools like whoami)
    const handler = MCPServer.handlers[name];

    if (handler) {
      try {
        const result = await handler(args || {}, req, principal);
        return { jsonrpc: '2.0', id: msg.id, result };
      } catch (err) {
        console.error(`[mcp] Tool ${name} error:`, err);
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `Tool error: ${err.message}` }],
            isError: true
          }
        };
      }
    }

    // Fall back to agent registry tools
    const agentTool = MCPServer._findAgentTool(name);
    if (agentTool) {
      // Role gate (defense-in-depth — tools/list already filtered).
      if (!roleAllows(principal.role, agentTool.scope)) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `Insufficient role: '${principal.role}' cannot invoke a tool requiring '${agentTool.scope}'.` }],
            isError: true
          }
        };
      }
      return await MCPServer._invokeAgentTool(msg, req, principal, agentTool);
    }

    return {
      jsonrpc: '2.0',
      error: { code: -32602, message: `Unknown tool: ${name}` },
      id: msg.id
    };
  }

  // ── Agent tool discovery ──

  /**
   * Find a tool in the agent registry by name.
   */
  static _findAgentTool(name) {
    const agentManager = MCPServer._app?.locals?.agentManager;
    if (!agentManager) return null;
    return agentManager.getRegisteredTools().find(t => t.name === name) || null;
  }

  /**
   * Build the full tools list: static TOOLS + dynamic agent tools.
   * Agents that implement describeTools(domain) get dynamic descriptions
   * (e.g. horoscope profiles baked into the tool description).
   * AI notes from domain config are appended to descriptions when present.
   */
  static async _getAllTools(req) {
    const tools = [...TOOLS];
    const agentManager = MCPServer._app?.locals?.agentManager;
    if (!agentManager) return tools;

    const domain = req.hostname || 'localhost';

    // Load domain AI notes (stored in Config by admin)
    let aiNotes = '';
    try {
      const cfg = new Config();
      cfg.setPath(domain);
      aiNotes = cfg.data?.ai_notes || '';
    } catch (e) { /* ignore */ }

    // Collect agent tools, preferring dynamic descriptions
    for (const [, agentData] of agentManager.agents) {
      const manifest = agentData.manifest;
      if (!Array.isArray(manifest.tools)) continue;

      // Try dynamic descriptions from agent instance
      let dynamicTools = null;
      if (typeof agentData.instance?.describeTools === 'function') {
        try {
          dynamicTools = await agentData.instance.describeTools(domain);
        } catch (e) {
          console.error(`[mcp] ${manifest.name}.describeTools() failed:`, e.message);
        }
      }

      const routeName = manifest.name.replace(/^@/, '');
      const basePath = `/agent/${routeName}`;

      for (const manifestTool of manifest.tools) {
        // Use dynamic description if available, else static from manifest
        const dynamic = dynamicTools?.find(t => t.name === manifestTool.name);
        tools.push({
          name: manifestTool.name,
          description: dynamic?.description || manifestTool.description,
          inputSchema: dynamic?.inputSchema || manifestTool.inputSchema || { type: 'object', properties: {} },
          // Stash routing info (not part of MCP spec, but we need it for proxy)
          _agent: { basePath, path: manifestTool.path, method: manifestTool.method || 'GET', scope: manifestTool.scope }
        });
      }
    }

    // If AI notes exist, append them to the server-level context
    // by enriching the first tool's description (or adding a hint tool)
    if (aiNotes) {
      tools.push({
        name: 'domain_notes',
        description: `Domain-specific context set by the admin:\n${aiNotes}`,
        inputSchema: { type: 'object', properties: {} },
        _agent: null // not callable, just informational
      });
    }

    return tools;
  }

  // ── Principal resolution ───────────────────────────────────────────────────

  /**
   * Resolve the MCP caller to { caller, role, via }. Two credentials accepted:
   *   - a proven epistery identity (cookie/bot) in req.episteryClient, OR
   *   - an OAuth bearer (OAuthServer.resolveBearer → connection's derived address).
   * The role tier is read from the contract ACL (the source of truth) for the
   * caller — never trusted from the credential. Returns null when neither
   * credential is present.
   */
  static async _resolvePrincipal(req) {
    if (req.episteryClient?.authenticated) {
      const caller = req.episteryClient.identityAddress;
      return { caller, role: await MCPServer._roleTier(req, caller), via: req.episteryClient.authType };
    }
    const oauth = await OAuthServer.resolveBearer(req);
    if (oauth) {
      return { caller: oauth.caller, role: await MCPServer._roleTier(req, oauth.caller), via: 'oauth', clientId: oauth.clientId };
    }
    return null;
  }

  /**
   * Map an address to its coarse role tier (admin/edit/read) using the domain
   * contract ACL — the source of truth. Returns null when the address has no
   * grant (no MCP access).
   */
  static async _roleTier(req, address) {
    if (!address) return null;
    try {
      if (req.domainAcl && await req.domainAcl.isAdmin(address)) return 'admin';
      const contract = req.domainAcl?.chain?.contract;
      if (contract) {
        const memberships = await contract.getListsForMember(address);
        const max = memberships.reduce((m, e) => Math.max(m, Number(e.role) || 0), 0);
        if (max >= 2) return 'edit';
        if (max >= 1) return 'read';
      }
    } catch (e) {
      console.error('[mcp] role resolve error:', e.message);
    }
    return null;
  }

  // ── In-process agent tool invocation ───────────────────────────────────────

  /** Find the mounted agent whose router serves a tool's basePath. */
  static _findAgentData(basePath) {
    const am = MCPServer._app?.locals?.agentManager;
    if (!am) return null;
    for (const [, data] of am.agents) {
      if (data.shortPath === basePath) return data;
    }
    return null;
  }

  /**
   * Invoke an agent tool IN-PROCESS against the agent's mounted router — no
   * loopback HTTP, no bearer re-forwarding, no extra trust surface (the model
   * used by epistery.app/lib/mcp.mjs).
   *
   * The agent receives a synthetic request carrying the MCP principal contract:
   *   req.mcp     = true               — this call arrived via MCP, already
   *                                      role-gated by scope→role above.
   *   req.caller  = principal.caller   — the acting address (authorship/ACL).
   *   req.role    = principal.role     — coarse tier (read/edit/admin).
   * Agents authorize MCP calls from req.role/req.caller (req.episteryClient is
   * intentionally absent — the bearer is not a global identity).
   */
  static async _invokeAgentTool(msg, req, principal, tool) {
    const args = msg.params?.arguments || {};
    const routing = tool._agent || {
      basePath: tool.basePath,
      path: tool.path,
      method: (tool.method || 'GET').toUpperCase(),
      scope: tool.scope
    };

    if (!routing.basePath) {
      return MCPServer._toolError(msg.id, `Tool "${msg.params.name}" has no route configured`);
    }
    const agentData = MCPServer._findAgentData(routing.basePath);
    if (!agentData?.activeRouter) {
      return MCPServer._toolError(msg.id, `Agent for "${msg.params.name}" is not mounted`);
    }

    const method = (routing.method || 'GET').toUpperCase();

    // Substitute {param} placeholders from args; remaining args become query
    // (GET/DELETE) or body (POST/PUT/PATCH).
    const usedParams = new Set();
    const path = (routing.path || '/').replace(/\{(\w+)\}/g, (m, param) => {
      if (args[param] != null) { usedParams.add(param); return encodeURIComponent(args[param]); }
      return m;
    });
    const query = {};
    let body;
    if (method === 'GET' || method === 'DELETE') {
      for (const [k, v] of Object.entries(args)) if (v != null && !usedParams.has(k)) query[k] = v;
    } else {
      body = {};
      for (const [k, v] of Object.entries(args)) if (!usedParams.has(k)) body[k] = v;
    }

    const synthReq = {
      method,
      url: path,
      originalUrl: routing.basePath + path,
      baseUrl: routing.basePath,
      path,
      headers: {},
      body,
      params: {},
      query,
      hostname: req.hostname,
      app: req.app,
      domainAcl: req.domainAcl,
      // MCP principal contract (see method doc):
      mcp: true,
      caller: principal.caller,
      role: principal.role,
      get(name) { return this.headers[name.toLowerCase()]; }
    };

    try {
      const { status, body: out } = await MCPServer._runRouter(agentData.activeRouter, synthReq);
      if (status >= 400) {
        return MCPServer._toolError(msg.id, `HTTP ${status}: ${typeof out === 'string' ? out : JSON.stringify(out)}`);
      }
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      return { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } };
    } catch (err) {
      console.error(`[mcp] Agent tool ${msg.params.name} error:`, err);
      return MCPServer._toolError(msg.id, `Agent tool error: ${err.message}`);
    }
  }

  /**
   * Run an Express router against a synthetic req. Resolves { status, body }.
   * Router fall-through (next without a response) resolves as 404.
   */
  static _runRouter(router, req) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (status, body) => { if (!settled) { settled = true; resolve({ status, body }); } };
      const res = {
        statusCode: 200,
        headersSent: false,
        headers: {},
        locals: {},
        status(code) { this.statusCode = code; return this; },
        set(name, val) { this.headers[String(name).toLowerCase()] = val; return this; },
        setHeader(name, val) { this.headers[String(name).toLowerCase()] = val; return this; },
        getHeader(name) { return this.headers[String(name).toLowerCase()]; },
        json(obj) { finish(this.statusCode, obj); return this; },
        send(b) { finish(this.statusCode, b); return this; },
        end(b) { finish(this.statusCode, b ?? null); return this; }
      };
      const next = (err) => {
        if (err) { if (!settled) { settled = true; reject(err); } return; }
        finish(404, { error: 'not found' });
      };
      try { router(req, res, next); }
      catch (e) { if (!settled) reject(e); }
    });
  }

  static _toolError(id, text) {
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
  }
}
