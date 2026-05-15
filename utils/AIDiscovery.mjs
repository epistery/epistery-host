/**
 * AIDiscovery — Dynamic /.well-known/ai endpoint for epistery-host.
 *
 * Mounts via AIDiscovery.attach(app), same pattern as OAuthServer/MCPServer.
 * Builds domain-specific AI Discovery JSON (v1.2) from:
 *   - Config (wallet, contract, provider)
 *   - AgentManager (live agent inventory)
 *   - Per-agent aiDiscovery() contributions (optional method on agent instances)
 */

import { Config } from 'epistery';
import crypto from 'crypto';

export class AIDiscovery {
  static attach(app) {
    app.get('/.well-known/ai', async (req, res) => {
      try {
        const domain = req.hostname || 'localhost';
        const cfg = new Config();
        cfg.setPath(domain);

        const wallet = cfg.data?.wallet || {};
        const provider = cfg.data?.provider || {};
        const contractAddress = cfg.data?.contract_address || null;
        const hasContract = contractAddress && contractAddress !== '0x0000000000000000000000000000000000000000';
        const enabledAgents = cfg.data?.enabled_agents || {};

        // Build agents array from agentManager
        const agents = [];
        const agentManager = app.locals.agentManager;

        if (agentManager) {
          for (const [, agentData] of agentManager.agents) {
            const manifest = agentData.manifest;
            // Skip agents disabled for this domain
            if (enabledAgents[manifest.name] === false) continue;

            const entry = {
              name: manifest.name,
              version: manifest.version || '0.1.0',
              description: manifest.description || '',
              base_url: agentData.shortPath
            };

            // Call agent's aiDiscovery() if it exists
            if (typeof agentData.instance?.aiDiscovery === 'function') {
              try {
                const contribution = await agentData.instance.aiDiscovery(domain);
                if (contribution && typeof contribution === 'object') {
                  if (contribution._toplevel) {
                    Object.assign(discovery, contribution._toplevel);
                    delete contribution._toplevel;
                  }
                  Object.assign(entry, contribution);
                }
              } catch (err) {
                console.error(`[ai-discovery] ${manifest.name}.aiDiscovery() failed:`, err.message);
              }
            }

            agents.push(entry);
          }
        }

        // Build blockchain section
        const blockchain = hasContract ? {
          chain: provider.name || 'Polygon Mainnet',
          chainId: parseInt(provider.chainId) || 137,
          contract: contractAddress,
          wallet: wallet.address || null,
          rpc: provider.publicRpc || null
        } : null;

        const now = new Date().toISOString();
        const discovery = {
          specVersion: '1.2.0',
          standard: 'AI Discovery Standard v1.2',
          generated: now,
          identity: {
            name: domain,
            domain: domain,
            platform: 'epistery-host'
          },
          capabilities: {
            agents: { available: agents.length > 0 },
            blockchain: { available: !!hasContract },
            mcp: { available: true, url: '/mcp', auth: 'oauth2' },
            knowledge: { available: false },
            content: { available: false }
          },
          agents,
          blockchain,
          well_known: {
            epistery_status: '/.well-known/epistery/status',
            epistery_agents: '/.well-known/epistery/agent/',
            oauth_authorization_server: '/.well-known/oauth-authorization-server',
            oauth_protected_resource: '/.well-known/oauth-protected-resource',
            ai_discovery: '/.well-known/ai'
          }
        };

        // Inline the feed catalog with recent posts. Presence of the
        // top-level `feeds` key IS the signal — no capability flag needed.
        // The aggregator strips heavy media; the per-feed endpoint serves
        // full fidelity for clients that want it.
        try {
          const aiAgent = findAgent(app.locals.agentManager, 'rootz-global/ai-discovery-host');
          if (aiAgent?.aiFeedsInline) {
            const feeds = await aiAgent.aiFeedsInline(domain, domain, app.locals.agentManager, 5);
            if (feeds && feeds.length) discovery.feeds = feeds;
          }
        } catch (e) {
          // Optional enrichment — never block manifest on it.
        }

        // Sign the manifest with the domain contract identity
        if (hasContract) {
          const sortKeys = (obj) => {
            if (Array.isArray(obj)) return obj.map(sortKeys);
            if (obj && typeof obj === 'object') {
              return Object.keys(obj).sort().reduce((sorted, key) => {
                sorted[key] = sortKeys(obj[key]);
                return sorted;
              }, {});
            }
            return obj;
          };
          // Hash without volatile fields — generated changes per request
          const hashTarget = { ...discovery };
          delete hashTarget.generated;
          const canonical = JSON.stringify(sortKeys(hashTarget));
          const contentHash = crypto.createHash('sha256').update(canonical).digest('hex');
          discovery._signature = {
            method: 'epistery-domain-v1',
            digitalName: contractAddress,
            network: provider.name || 'unknown',
            contentHash: `sha256:${contentHash}`,
            signedAt: now
          };
        }

        res.json(discovery);
      } catch (error) {
        console.error('[ai-discovery] Error:', error);
        res.status(500).json({ error: 'Failed to generate AI discovery' });
      }
    });

    // feeds-spec-v0: posts envelope for one feed id. Delegates to the
    // rootz/ai-discovery agent which routes to whichever plugin claims
    // the feed id and normalizes the post shape.
    app.get('/.well-known/ai/feeds/:id', async (req, res) => {
      try {
        const domain = req.hostname || 'localhost';
        const agent = findAgent(app.locals.agentManager, 'rootz-global/ai-discovery-host');
        if (!agent || typeof agent.aiFeed !== 'function') {
          return res.status(404).json({ error: 'Feed not found' });
        }
        const cfg = new Config();
        cfg.setPath(domain);
        const sourceContract = cfg.data?.contract_address || null;
        const envelope = await agent.aiFeed(
          domain, domain, req.params.id,
          app.locals.agentManager,
          { since: req.query.since, limit: req.query.limit },
          sourceContract
        );
        if (!envelope) return res.status(404).json({ error: 'Feed not found' });
        res.json(envelope);
      } catch (e) {
        console.error('[ai-discovery] feed proxy error:', e);
        res.status(500).json({ error: e.message });
      }
    });
  }
}

function findAgent(agentManager, name) {
  if (!agentManager) return null;
  for (const [, agentData] of agentManager.agents) {
    if (agentData.manifest.name === name) return agentData.instance;
  }
  return null;
}
