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
 * Auth: requires req.episteryClient (set by OAuthServer's Bearer middleware).
 * Returns 401 with WWW-Authenticate pointing to /.well-known/oauth-protected-resource
 * to trigger the OAuth discovery flow.
 *
 * Adapted from Steven's /opt/mcp-agent/index.mjs.
 */

import { TOOLS, createHandlers } from './MCPTools.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'epistery', version: '0.1.0' };

export class MCPServer {
  static handlers = null;

  static attach(app) {
    const port = parseInt(process.env.PORT || 4080);
    MCPServer.handlers = createHandlers(port);

    // ── POST /mcp — JSON-RPC requests ──
    app.post('/mcp', async (req, res) => {
      // Auth check: 401 triggers OAuth discovery
      if (!req.episteryClient?.authenticated || req.episteryClient.authType !== 'oauth') {
        return res.status(401)
          .set('WWW-Authenticate', `Bearer resource_metadata="https://${req.hostname}/.well-known/oauth-protected-resource"`)
          .json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Authentication required. Use OAuth 2.1 to obtain a Bearer token.' },
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
      if (!req.episteryClient?.authenticated || req.episteryClient.authType !== 'oauth') {
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
        return { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };

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

    const handler = MCPServer.handlers[name];
    if (!handler) {
      return {
        jsonrpc: '2.0',
        error: { code: -32602, message: `Unknown tool: ${name}` },
        id: msg.id
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
}
