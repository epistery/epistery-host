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
import { TOOLS, TOOL_SCOPES, hasScope, createHandlers } from './MCPTools.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'epistery', version: '0.1.0' };

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
      // Auth check: accept OAuth Bearer or epistery bot-auth
      if (!req.episteryClient?.authenticated) {
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
          const result = await MCPServer._dispatch(msg, req);
          if (result !== null) results.push(result);
        }
        if (results.length === 0) return res.status(204).end();
        return res.json(results);
      }

      // Handle single JSON-RPC message
      const result = await MCPServer._dispatch(body, req);
      if (result === null) {
        res.status(204).end();
      } else {
        res.json(result);
      }
    });

    // ── GET /mcp — SSE stream ──
    // Some MCP clients (Claude Code) open a GET SSE connection first.
    app.get('/mcp', (req, res) => {
      if (!req.episteryClient?.authenticated) {
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

  static async _dispatch(msg, req) {
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

      case 'tools/list':
        return { jsonrpc: '2.0', id: msg.id, result: { tools: await MCPServer._getAllTools(req) } };

      case 'tools/call':
        return await MCPServer._handleCallTool(msg, req);

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

  static async _handleCallTool(msg, req) {
    const { name, arguments: args } = msg.params || {};

    if (!name) {
      return {
        jsonrpc: '2.0',
        error: { code: -32602, message: 'Invalid params: missing tool name' },
        id: msg.id
      };
    }

    // Check static handlers first
    const handler = MCPServer.handlers[name];

    if (handler) {
      // Enforce OAuth scopes for static tools
      const requiredScope = TOOL_SCOPES[name];
      if (requiredScope !== undefined && !hasScope(req, requiredScope)) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: `Insufficient scope. Required: ${requiredScope}` }],
            isError: true
          }
        };
      }

      try {
        const result = await handler(args || {}, req);
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
      return await MCPServer._proxyAgentTool(msg, req, agentTool);
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
          _agent: { basePath, path: manifestTool.path, method: manifestTool.method || 'GET' }
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

  /**
   * Proxy a tools/call request to an agent's internal HTTP endpoint.
   * Uses the same loopback pattern as static tool handlers.
   */
  static async _proxyAgentTool(msg, req, tool) {
    const port = MCPServer._port;
    const args = msg.params?.arguments || {};

    // Resolve routing info — either stashed from _getAllTools or from registry
    const routing = tool._agent || {
      basePath: tool.basePath,
      path: tool.path,
      method: (tool.method || 'GET').toUpperCase()
    };

    if (!routing.basePath) {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `Tool "${msg.params.name}" has no route configured` }],
          isError: true
        }
      };
    }

    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Forwarded-Host': req.headers?.host || 'localhost'
    };
    const authHeader = req.headers?.authorization;
    if (authHeader) headers['Authorization'] = authHeader;

    const method = routing.method || 'GET';
    let url;

    // Substitute path parameters ({name}, {id}, etc.) from args
    let resolvedPath = routing.path;
    const usedParams = new Set();
    resolvedPath = resolvedPath.replace(/\{(\w+)\}/g, (match, param) => {
      if (args[param] != null) {
        usedParams.add(param);
        return encodeURIComponent(args[param]);
      }
      return match;
    });

    if (method === 'GET') {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) {
        if (v != null && !usedParams.has(k)) qs.set(k, v);
      }
      const qsStr = qs.toString();
      url = `http://127.0.0.1:${port}${routing.basePath}${resolvedPath}${qsStr ? '?' + qsStr : ''}`;
    } else {
      url = `http://127.0.0.1:${port}${routing.basePath}${resolvedPath}`;
    }

    try {
      const fetchOpts = { method, headers };
      if (method !== 'GET') {
        // Exclude params already substituted into the path
        const bodyArgs = {};
        for (const [k, v] of Object.entries(args)) {
          if (!usedParams.has(k)) bodyArgs[k] = v;
        }
        fetchOpts.body = JSON.stringify(bodyArgs);
      }

      const res = await fetch(url, fetchOpts);
      const data = await res.json();

      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
        }
      };
    } catch (err) {
      console.error(`[mcp] Agent tool ${msg.params.name} proxy error:`, err);
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: [{ type: 'text', text: `Agent tool error: ${err.message}` }],
          isError: true
        }
      };
    }
  }
}
