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

/**
 * Create tool handlers. Handlers receive (args, req, principal) where principal
 * is the MCP-resolved { caller, role, via, clientId } — see MCPServer.
 * @param {number} port — Internal epistery-host port (reserved; in-process now)
 * @returns {Object} Map of tool name -> handler function
 */
export function createHandlers(port) {
  return {
    async whoami(args, req, principal) {
      // The principal is the MCP-resolved caller: an epistery identity
      // (cookie/bot) or an OAuth connection's derived address. `role` is the
      // coarse tier read from the contract ACL.
      const info = {
        caller: principal?.caller || null,
        role: principal?.role || null,
        via: principal?.via || 'none',
        clientId: principal?.clientId || null,
        domain: req.hostname
      };
      return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
    }
  };
}
