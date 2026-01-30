# Epistery-Host Contracts

## DomainAgent.sol

The DomainAgent contract is the core access control and data management contract for epistery-host domains.

### Features

- **Access Control Lists (ACLs)**: Named lists with role-based permissions (0=none, 1=read, 2=write, 3=admin, 4=owner)
- **Automatic Admin Access**: Sponsor (deployer) and owner are automatically granted admin privileges
- **Approval System**: Workflow for requesting and handling approvals between addresses
- **Attribute Storage**: Public and private key-value storage per address

### Compiling

```bash
npm run build
```

This compiles the contract and generates artifacts in `artifacts/contracts/DomainAgent.sol/`.

### Version

Current version: **v1.0.0**

The contract version is embedded in the contract at `DomainAgent.VERSION` and is used by epistery-host to determine when upgrades are available.

### Usage

The contract is automatically loaded by epistery-host from `artifacts/contracts/DomainAgent.sol/DomainAgent.json`.

Key functions:
- `addToACL(listName, address, name, role, meta)` - Add address to an ACL
- `isInACL(owner, listName, address)` - Check if address is in ACL
- `getACL(owner, listName)` - Get all entries in an ACL
- `setPublicAttribute(key, value)` - Store public attribute
- `setPrivateAttribute(key, value)` - Store private attribute (only owner can read)
