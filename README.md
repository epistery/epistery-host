# Epistery Host

The Epistery Host is intended to provide epistery agent services on behalf of one or more domains. It is
connected through a DNS CNAME, manages the domain key and provides the services of the epistery server
npm plugin along with the browser javascript

The Epistery Host implements a plugin model that launches chosen agents to add routes and wield the domain key.
These include a wiki, message board, file manager, secrets manager, and more. It's open. The
Epistery host code endeavors to provide a harness for these features, remaining slim itself.

Agents declare their MCP (Model Context Protocol) tools in their own `epistery.json` manifests. The host
discovers these at startup and proxies MCP tool calls to each agent's internal HTTP endpoint. Only host-level
tools (like `whoami`) remain in MCPTools.mjs.

## Features

### Domain Initialization

When first accessed, unclaimed domains are presented with a guided claiming process:

1. **Blockchain Selection** - Choose the network for domain operations (Polygon mainnet default)
2. **Wallet Connection** - Connect via Web3 wallet (MetaMask) or generate a browser-based wallet
3. **DNS Verification** - Prove ownership by adding a TXT record to the domain
4. **Admin Establishment** - The verified wallet address becomes the domain administrator

### Status Page

Once claimed, the domain displays a clean status interface showing:

* Domain name and configuration details
* Server wallet address
* Active modules and their public-facing content
* **Browser Wallet** button - Manage domain-specific identity and data wallet
* **Administrate** button - Visible only to the verified admin address

### Agent System

Agents are discovered from `~/.epistery/.agents/` and mounted at `/agent/{namespace}/{name}/*`. Each agent
has an `epistery.json` manifest declaring its name, entry point, optional UI widget, and optional `tools`
array for MCP integration. Agents with tools get automatic MCP proxy — each tool declares its HTTP method,
path, input schema, and OAuth scope.

Current agents include wiki, message board, files, relay, provenance, secrets, connectors (weather,
finance), publisher, scan, environs, and mimi (voice portal).

### Technical Architecture

* Runs on ports 4080 (HTTP) and 4443 (HTTPS)
* Uses `@metric-im/administrate/Certify` for SSL certificate management
* Domain configuration via epistery `Config` module
* Clean, framework-free frontend (no React/Vue)

## Agent Configuration Pattern

### Storage in DomainAgent Contract

**All agent configuration data is stored in the DomainAgent contract, not in Config files.**

The contract provides public attribute storage accessible via:
- `setPublicAttribute(key, value)` - Store configuration
- `getPublicAttribute(owner, key)` - Retrieve configuration

### Configuration Key Pattern

Agent configuration is stored using the agent's formal name from `package.json` as the key:

```
Key: "@epistery/wiki"
Value: JSON.stringify({
  aclStance: {
    acl: [
      { list: "epistery::admin", access: 3 },
      { list: "default", access: 0 }
    ],
    enableRequestAccess: false
  }
})
```

### ACL Stance Object

The `aclStance` object within agent configuration defines access control:

```javascript
{
  acl: [
    { list: string, access: number }  // ACL list mappings, including 'default'
  ],
  enableRequestAccess: boolean  // Show "Request Access" button
}
```

The special `default` list entry defines access for users not in any named ACL list.

Access levels:
- `0` = None (denied)
- `1` = Read
- `2` = Write
- `3` = Admin

### Implementation in acl.mjs

**Reading configuration:**
```javascript
const contract = await getContract(contractAddress, domain);
const configJson = await contract.getPublicAttribute(contract.signer.address, agentName);
const agentConfig = JSON.parse(configJson);
const aclStance = agentConfig.aclStance;
```

**Saving configuration:**
```javascript
const contract = await getContract(contractAddress, domain);
let agentConfig = JSON.parse(await contract.getPublicAttribute(contract.signer.address, agentName)) || {};
agentConfig.aclStance = {
  acl: [
    { list: "epistery::admin", access: 3 },
    { list: "default", access: 0 }
  ],
  enableRequestAccess: false
};
await contract.setPublicAttribute(agentName, JSON.stringify(agentConfig));
```

### API Routes

- `GET /api/acl?agent=@epistery/wiki` - Retrieve agent ACL configuration
- `PUT /api/acl` - Save agent ACL list mappings including 'default' (requires `{agent, acl}`)
- `PUT /api/acl/auth-strategy` - Save enableRequestAccess (requires `{agent, authConfig: {enableRequestAccess}}`)

### Default Behavior

By default, all agents have:
- `epistery::admin` with admin access (level 3)
- `default` with no access (level 0) - for users not in any named list

The special `default` entry in the acl array replaces the previous separate defaultStrategy field, simplifying the configuration structure.

## Storage

All agent data is encrypted at rest using AES-256-GCM with a per-domain master key derived from the domain
wallet's signature. The encryption is transparent to agents — they read and write plaintext, and the storage
layer handles encryption/decryption automatically.

Storage defaults to the host's configured Storj (or any S3-compatible) backend. Domain admins can set their
own `[storj]` credentials in the domain config to use their own storage account. The storage provider is
interchangeable — the trust is in the domain key, not the provider.

### Configuration

Set S3-compatible credentials in the domain config (`~/.epistery/{domain}/config.ini`) or the root config:

```ini
[storj]
ACCESS_KEY=...
SECRET_KEY=...
ENDPOINT=https://gateway.storjshare.io
BUCKET=epistery
```

Domain-level credentials take precedence over root-level.

## Future Todo Notes

Config stores domain private keys in the home folder. We will soon want a verion of the config module that uses
HSM features available through OCI to properly secure these keys in hardware.

I have not yet thought through how to, or if to, bind browser keys (currently called rivets) lax. localStorage
is strict, so epistery.publisherdomain.com is a different key from publisherdomain.com.

Graphs and charts are fun. The epistery host status page should show innocuous data about the page traffic.
A white-washed glimpse at google analytics for the domain. The user should be given buttons to see their
address data on third party sites. It's important to reinforce that the user information is theirs and theirs
alone to share.
