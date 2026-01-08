import { join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from "url";
import path from "path";
import { Config } from 'epistery';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ethers = require('ethers');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default class Pages {
  constructor(options) {
    this.rootPath = join(__dirname, 'pages');
    this.options = options || {};
    this.templates = {};
    this.AgentArtifact = options?.AgentArtifact;
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
    // Serve template pages (for iframing into agent admin pages)
    app.get('/page/:page', (req, res) => {
      res.set('Content-Type', 'text/html');
      res.send(this.render(req.params.page, {}));
    });

    // API: Get ACL configuration from contract private attributes
    app.get('/api/acl', async (req, res) => {
      try {
        const { agent } = req.query;
        if (!agent) {
          return res.status(400).json({ error: 'Agent name required' });
        }

        const domain = req.hostname || 'localhost';
        const cfg = new Config();
        cfg.setPath(domain);

        const { contract } = await this.getContract(cfg);
        const configData = await contract.getPrivateAttribute(agent);

        let agentConfig = {};
        if (configData && configData.length > 0) {
          try {
            agentConfig = JSON.parse(configData);
          } catch (e) {
            console.error('[acl] Failed to parse agent config:', e);
          }
        }

        res.json({ acl: agentConfig.acl || [] });
      } catch (error) {
        console.error('[acl] Error getting ACL:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Update ACL configuration in contract private attributes
    app.put('/api/acl', async (req, res) => {
      try {
        const { agent, acl } = req.body;
        if (!agent || !Array.isArray(acl)) {
          return res.status(400).json({ error: 'Agent name and ACL array required' });
        }

        // Check if user is admin
        if (!req.episteryClient || !req.app.locals.epistery) {
          return res.status(401).json({ error: 'Not authenticated' });
        }

        const isAdmin = await req.app.locals.epistery.isListed(req.episteryClient.address, 'epistery::admin');
        if (!isAdmin) {
          return res.status(403).json({ error: 'Only epistery::admin can update ACLs' });
        }

        const domain = req.hostname || 'localhost';
        const cfg = new Config();
        cfg.setPath(domain);

        const { contract, feeData } = await this.getContract(cfg);

        // Read existing config, update ACL, write back
        let agentConfig = {};
        try {
          const existingData = await contract.getPrivateAttribute(agent);
          if (existingData && existingData.length > 0) {
            agentConfig = JSON.parse(existingData);
          }
        } catch (e) {
          console.error('[acl] Error creating new config');
        }

        agentConfig.acl = acl;

        const tx = await contract.setPrivateAttribute(agent, JSON.stringify(agentConfig), feeData);
        await tx.wait();

        res.json({ success: true, acl });
      } catch (error) {
        console.error('[acl] Error updating ACL:', error);
        res.status(500).json({ error: error.message });
      }
    });
  }

  async getContract(cfg) {
    const contractAddress = cfg.data?.agent_contract_address || process.env.AGENT_CONTRACT_ADDRESS;
    if (!contractAddress) throw new Error('Contract not deployed');

    const serverWallet = cfg.data?.wallet;
    const provider = cfg.data?.provider;
    if (!serverWallet || !provider) throw new Error('Server not configured');

    const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);
    const wallet = ethers.Wallet.fromMnemonic(serverWallet.mnemonic).connect(ethersProvider);

    const feeData = await ethersProvider.getFeeData();
    const minGasPrice = ethers.utils.parseUnits("30", "gwei");
    const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
    const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;
    const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
    const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);

    return {
      contract: new ethers.Contract(contractAddress, this.AgentArtifact.abi, wallet),
      feeData: { maxPriorityFeePerGas, maxFeePerGas }
    };
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
