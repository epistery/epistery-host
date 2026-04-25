/**
 * MCP Tool Definitions — static (host-level) tools.
 *
 * Agent-declared tools are discovered dynamically from epistery.json manifests.
 * Only host-level tools that read from req (not proxied to agents) live here.
 */

export const TOOLS = [
  {
    name: 'whoami',
    description: 'Show your current wallet identity, auth method, and permissions.',
    inputSchema: { type: 'object', properties: {} }
  }
];

export function hasScope(req, required) {
  if (!required) return true;
  // Bot-auth access is governed by ACL lists, not OAuth scopes
  if (req.episteryClient?.authType === 'bot') return true;
  const granted = req.oauthScope || '';
  return granted.split(' ').includes(required);
}

/**
 * Create tool handlers bound to an internal port.
 * @param {number} port — Internal epistery-host port
 * @returns {Object} Map of tool name -> handler function
 */
export function createHandlers(port) {
  return {
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
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }
  };
}
