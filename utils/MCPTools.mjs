/**
 * MCP Tool Definitions and Handlers.
 *
 * Each tool proxies to an existing epistery agent via internal HTTP.
 * The Bearer token is forwarded so req.episteryClient is set on internal requests.
 *
 * Adapted from Steven's /opt/mcp-agent/tools.mjs.
 */

export const TOOLS = [
  // ── Wiki ──
  {
    name: 'wiki_read',
    description: 'Read a wiki page by title. Returns the page content in markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Page title (e.g., "Home")' }
      },
      required: ['page']
    }
  },
  {
    name: 'wiki_write',
    description: 'Create or update a wiki page. Content should be markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Page title' },
        content: { type: 'string', description: 'Page content (markdown)' }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'wiki_list',
    description: 'List all wiki pages. Returns titles and metadata.',
    inputSchema: { type: 'object', properties: {} }
  },

  // ── Archives ──
  {
    name: 'archive_create',
    description: 'Create an archive of AI conversation content, code, notes, or any text.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Archive title' },
        content: { type: 'string', description: 'Content to archive' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for organization' },
        templateType: { type: 'string', description: 'Template type (CODE_REVIEW, DESIGN_DISCUSSION, RESEARCH, etc.)' }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'archive_list',
    description: 'List archives with optional filtering by tags or template type.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)' },
        offset: { type: 'number', description: 'Pagination offset' },
        tags: { type: 'string', description: 'Filter by tag (comma-separated)' },
        template: { type: 'string', description: 'Filter by template type' }
      }
    }
  },
  {
    name: 'archive_search',
    description: 'Full-text search across all archives.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      },
      required: ['query']
    }
  },
  {
    name: 'archive_read',
    description: 'Read a specific archive by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Archive ID' }
      },
      required: ['id']
    }
  },
  {
    name: 'archive_stats',
    description: 'Get archive statistics: total count, tag breakdown, date range.',
    inputSchema: { type: 'object', properties: {} }
  },

  // ── Messages ──
  {
    name: 'message_list',
    description: 'List message board posts.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'message_post',
    description: 'Post a message to the message board.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message content' }
      },
      required: ['text']
    }
  },

  // ── Secrets ──
  {
    name: 'secret_list',
    description: 'List available secrets (metadata only, no decryption).',
    inputSchema: { type: 'object', properties: {} }
  },

  // ── Identity ──
  {
    name: 'whoami',
    description: 'Show your current wallet identity, auth method, and permissions.',
    inputSchema: { type: 'object', properties: {} }
  }
];

// Map each tool to its required scope
export const TOOL_SCOPES = {
  wiki_read: 'wiki:read',
  wiki_write: 'wiki:write',
  wiki_list: 'wiki:read',
  archive_create: 'archive:write',
  archive_list: 'archive:read',
  archive_search: 'archive:read',
  archive_read: 'archive:read',
  archive_stats: 'archive:read',
  message_list: 'messages:read',
  message_post: 'messages:write',
  secret_list: 'secrets:read',
  whoami: null  // no scope required
};

export function hasScope(req, required) {
  if (!required) return true;
  const granted = req.oauthScope || '';
  return granted.split(' ').includes(required);
}

/**
 * Create tool handlers bound to an internal port.
 * @param {number} port — Internal epistery-host port
 * @returns {Object} Map of tool name -> handler function
 */
export function createHandlers(port) {

  async function api(path, req, opts = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Host': req.headers?.host || 'localhost'  // forward Host for domain routing
    };
    const authHeader = req.headers?.authorization;
    if (authHeader) headers['Authorization'] = authHeader;

    // Always connect to loopback — never use client-supplied hostname
    const url = `http://127.0.0.1:${port}${path}`;
    const res = await fetch(url, { ...opts, headers: { ...headers, ...opts.headers } });
    return res.json();
  }

  function text(data) {
    return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
  }

  function error(msg) {
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
  }

  return {
    // ── Wiki ──
    async wiki_read(args, req) {
      try {
        const data = await api(`/agent/epistery/wiki/${encodeURIComponent(args.page)}`, req);
        if (data.error) return error(data.error);
        return text(data.content || data);
      } catch (e) { return error(e.message); }
    },

    async wiki_write(args, req) {
      try {
        const data = await api(`/agent/epistery/wiki/${encodeURIComponent(args.title)}`, req, {
          method: 'POST',
          body: JSON.stringify({ title: args.title, content: args.content })
        });
        return text(data);
      } catch (e) { return error(e.message); }
    },

    async wiki_list(args, req) {
      try {
        const data = await api('/agent/epistery/wiki/index', req);
        return text(data);
      } catch (e) { return error(e.message); }
    },

    // ── Archives ──
    async archive_create(args, req) {
      try {
        const payload = { title: args.title, content: args.content, tags: args.tags || [], templateType: args.templateType };
        const data = await api('/agent/rootz/archive-agent/create', req, {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        return text(data);
      } catch (e) { return error(e.message); }
    },

    async archive_list(args, req) {
      try {
        const params = new URLSearchParams();
        if (args.limit) params.set('limit', args.limit);
        if (args.offset) params.set('offset', args.offset);
        if (args.tags) params.set('tags', args.tags);
        if (args.template) params.set('template', args.template);
        const qs = params.toString();
        const data = await api(`/agent/rootz/archive-agent/list${qs ? '?' + qs : ''}`, req);
        return text(data);
      } catch (e) { return error(e.message); }
    },

    async archive_search(args, req) {
      try {
        const params = new URLSearchParams({ q: args.query });
        if (args.limit) params.set('limit', args.limit);
        const data = await api(`/agent/rootz/archive-agent/search?${params}`, req);
        return text(data);
      } catch (e) { return error(e.message); }
    },

    async archive_read(args, req) {
      try {
        const data = await api(`/agent/rootz/archive-agent/read/${encodeURIComponent(args.id)}`, req);
        if (data.error) return error(data.error);
        return text(data);
      } catch (e) { return error(e.message); }
    },

    async archive_stats(args, req) {
      try {
        const data = await api('/agent/rootz/archive-agent/stats', req);
        return text(data);
      } catch (e) { return error(e.message); }
    },

    // ── Messages ──
    async message_list(args, req) {
      try {
        const data = await api('/agent/epistery/message-board/api/posts', req);
        return text(data);
      } catch (e) { return error(e.message); }
    },

    async message_post(args, req) {
      try {
        const data = await api('/agent/epistery/message-board/api/posts', req, {
          method: 'POST',
          body: JSON.stringify({ text: args.text })
        });
        return text(data);
      } catch (e) { return error(e.message); }
    },

    // ── Secrets ──
    async secret_list(args, req) {
      try {
        const data = await api('/agent/rootz/secret-agent/secrets', req);
        return text(data);
      } catch (e) { return error(e.message); }
    },

    // ── Identity ──
    async whoami(args, req) {
      const info = {
        wallet: req.episteryClient?.address || null,
        clientId: req.episteryClient?.clientId || null,
        clientName: req.episteryClient?.clientName || null,
        authMethod: req.episteryClient?.authType || 'none',
        oauthScope: req.oauthScope || null,
        authenticated: !!req.episteryClient?.authenticated,
        domain: req.hostname
      };
      return text(info);
    }
  };
}
