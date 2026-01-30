import { join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from "url";
import path from "path";
import { Config } from 'epistery';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class Pages {
  constructor(options) {
    this.rootPath = join(__dirname, 'public/pages');
    this.options = options || {};
    this.templates = {};
  }

  render(page,args) {
    try {
      let html = this.templates[page];
      if (!html) {
        this.templates[page] = new TemplateFile(join(__dirname, `${page}.html`));
      }
      return this.templates[page].parse(args);
    } catch(e) {
      console.error(e);
      return "Page not found";
    }
  }

  attach(app) {
    // Middleware to enrich episteryClient with ACL data and add public access helper
    app.use(async (req, res, next) => {
      try {
        const domain = req.hostname || 'localhost';
        const cfg = new Config();
        cfg.setPath(domain);

        // Skip ACL middleware if no contract deployed
        const contractAddress = cfg.data?.agent_contract_address || process.env.AGENT_CONTRACT_ADDRESS;
        if (!contractAddress) {
          req.getAccessLevel = async (agentName) => 0; // No access if no contract
          return next();
        }

        const { contract } = await this.getContract(cfg);

        // Add helper to get access level for a client (authenticated or not)
        req.getAccessLevel = async (agentName) => {
          try {
            // Get ACL config for this agent
            const configData = await contract.getPrivateAttribute(agentName);
            let agentConfig = {};
            try {
              agentConfig = JSON.parse(configData);
            } catch (e) {
              console.error('[acl] Failed to parse agent config:', e);
            }
            const acl = agentConfig.acl || [];

            // Check for "public" entry (default access for all users)
            const publicEntry = acl.find(a => a.list === 'public');
            let maxLevel = publicEntry ? parseInt(publicEntry.access) || 0 : 0;

            // If authenticated, check user's list memberships
            if (req.episteryClient?.address) {
              const ownerAddress = cfg.data?.wallet?.address;
              if (ownerAddress) {
                const membershipEntries = await contract.getListsForMember(ownerAddress, req.episteryClient.address);
                const lists = membershipEntries.map(entry => entry.listName);

                // Find highest access level from user's lists
                for (const listName of lists) {
                  const aclEntry = acl.find(a => a.list === listName);
                  if (aclEntry) {
                    const level = parseInt(aclEntry.access) || 0;
                    if (level > maxLevel) maxLevel = level;
                  }
                }
              }
            }

            return maxLevel;
          } catch (error) {
            console.error('[acl] Error getting access level:', error);
            return 0;
          }
        };
      } catch (error) {
        console.error('[acl] Error setting up ACL middleware:', error);
      }
      next();
    });

    // Serve template pages (for iframing into agent admin pages)
    app.get('/page/:page', (req, res) => {
      res.set('Content-Type', 'text/html');
      res.send(this.render(req.params.page, {}));
    });
  }
}
class TemplateText {
  constructor(template) {
    this.template = template;
  }
  parse(data) {
    return this.template.replace(/\{\{([a-zA-Z0-9.]*)\}\}/g,(match, reference) => {
      return reference.split('.').reduce((acc, key) => {
        return acc && acc[key] !== undefined ? acc[key] : undefined;
      }, data);
    })
  }
}
class TemplateFile {
  constructor(filePath) {
    let fileData = readFileSync(filePath, 'utf8');
    if (!fileData) throw new Error(`Page not found`);
    return new TemplateText(fileData.toString());
  }
}
