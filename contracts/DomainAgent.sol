// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "epistery/contracts/IAddressNaming.sol";

/**
 * @title DomainAgent
 * @dev Domain-bound access control and data management contract
 *
 * A DomainAgent is bound to a domain name and provides:
 * - Named access control lists (ACLs) with role-based permissions
 * - Public and private attribute storage
 * - Approval workflow system
 * - Address naming (conforms to IAddressNaming for off-chain interop)
 *
 * The owner (contract deployer) and host automatically have admin access.
 */
contract DomainAgent is IAddressNaming {
  // Contract version
  string public constant VERSION = "1.4.1";

  // Domain this contract serves
  string public domain;

  // Contract owner (paid deployment fee, immutable)
  address public owner;

  // Contract host (defaults to owner, can be transferred)
  address public host;

  // ============================================================================
  // ACCESS CONTROL (ACL)
  // ============================================================================

  // ACL entry structure
  struct ACLEntry {
    address addr;
    string name;
    uint8 role;      // 0=none, 1=read, 2=write, 3=admin, 4=owner
    string meta;     // JSON metadata
  }

  // Membership entry for reverse lookup
  struct MembershipEntry {
    string listName;
    uint8 role;
    uint256 addedAt;
  }

  // Single ACL: listName => entries
  mapping(string => ACLEntry[]) private namedACLs;

  // List names (for enumeration)
  string[] private listNames;

  // Member reverse lookup: member => memberships
  mapping(address => MembershipEntry[]) private memberMemberships;

  // Address names — identity name lives on the address itself, not on any
  // (address, list) join. Roles stay on ACLEntry; the per-list `name` slot
  // on ACLEntry is now a per-list handle / role-label. Single-tenant here,
  // so no outer owner mapping. (Mirrors epistery Agent.sol v3.2.0.)
  mapping(address => string) private addressNames;

  // Events
  event ACLModified(address indexed host, string listName, address indexed addr, string action, uint256 timestamp);
  event AddressNameSet(address indexed addr, string name);
  event ApprovalRequested(address indexed approver, address indexed requestor, string fileName, string fileHash, uint256 timestamp);
  event ApprovalHandled(address indexed approver, address indexed requestor, string fileName, bool approved, uint256 timestamp);
  event AttributeSet(address indexed owner, string key, bool isPrivate, uint256 timestamp);
  event AttributeDeleted(address indexed owner, string key, bool isPrivate, uint256 timestamp);

  // ============================================================================
  // CONSTRUCTOR
  // ============================================================================

  constructor(string memory _domain, address _owner, address _host) {
    require(bytes(_domain).length > 0, "Domain cannot be empty");
    require(_owner != address(0), "Owner cannot be zero address");
    domain = _domain;
    owner = _owner;
    host = _host != address(0) ? _host : _owner;
  }

  // ============================================================================
  // ACL MANAGEMENT
  // ============================================================================

  /**
   * @dev Add an address to a named ACL (only host or owner)
   * @param listName The name of the list
   * @param addressToAdd The address to add
   * @param name Display name for the address
   * @param role Role level (0-4)
   * @param meta Metadata JSON string
   */
  function addToACL(
    string memory listName,
    address addressToAdd,
    string memory name,
    uint8 role,
    string memory meta
  ) external {
    require(msg.sender == host || msg.sender == owner, "Only host or owner can modify ACL");
    _addToACL(listName, addressToAdd, name, role, meta);
  }

  /**
   * @dev Internal helper for adding to ACL — used by both addToACL and redeemInvite
   */
  function _addToACL(
    string memory listName,
    address addressToAdd,
    string memory name,
    uint8 role,
    string memory meta
  ) internal {
    require(bytes(listName).length > 0, "List name cannot be empty");
    require(addressToAdd != address(0), "Address cannot be zero");
    require(role <= 4 || role == 255, "Invalid role: must be 0-4 or 255 (unset)");

    // Check if address is already in the list
    ACLEntry[] storage acl = namedACLs[listName];
    for (uint256 i = 0; i < acl.length; i++) {
      require(acl[i].addr != addressToAdd, "Address already in ACL");
    }

    // Track list name if not already tracked
    if (acl.length == 0) {
      listNames.push(listName);
    }

    uint8 effectiveRole = role == 255 ? 0 : role;

    ACLEntry memory entry = ACLEntry({
      addr: addressToAdd,
      name: name,
      role: effectiveRole,
      meta: meta
    });

    acl.push(entry);

    // Track membership for reverse lookup
    memberMemberships[addressToAdd].push(MembershipEntry({
      listName: listName,
      role: effectiveRole,
      addedAt: block.timestamp
    }));

    emit ACLModified(host, listName, addressToAdd, "add", block.timestamp);
  }

  /**
   * @dev Remove an address from a named ACL (only host or owner)
   * @param listName The name of the list
   * @param addressToRemove The address to remove
   */
  function removeFromACL(string memory listName, address addressToRemove) external {
    require(msg.sender == host || msg.sender == owner, "Only host or owner can modify ACL");
    require(bytes(listName).length > 0, "List name cannot be empty");
    require(addressToRemove != address(0), "Address cannot be zero");

    ACLEntry[] storage acl = namedACLs[listName];
    bool found = false;

    for (uint256 i = 0; i < acl.length; i++) {
      if (acl[i].addr == addressToRemove) {
        // Remove by replacing with last element and popping
        acl[i] = acl[acl.length - 1];
        acl.pop();
        found = true;
        break;
      }
    }

    require(found, "Address not in ACL");

    // Remove from membership tracking
    MembershipEntry[] storage memberships = memberMemberships[addressToRemove];
    for (uint256 i = 0; i < memberships.length; i++) {
      if (keccak256(bytes(memberships[i].listName)) == keccak256(bytes(listName))) {
        memberships[i] = memberships[memberships.length - 1];
        memberships.pop();
        break;
      }
    }

    emit ACLModified(host, listName, addressToRemove, "remove", block.timestamp);
  }

  /**
   * @dev Update an ACL entry's metadata (only host or owner)
   * @param listName The name of the list
   * @param addr The address to update
   * @param name New display name (use "\x00KEEP" to keep existing)
   * @param role New role (use 255 to keep existing)
   * @param meta New metadata (use "\x00KEEP" to keep existing)
   */
  function updateACLEntry(
    string memory listName,
    address addr,
    string memory name,
    uint8 role,
    string memory meta
  ) external {
    require(msg.sender == host || msg.sender == owner, "Only host or owner can modify ACL");
    require(bytes(listName).length > 0, "List name cannot be empty");
    require(addr != address(0), "Address cannot be zero");
    require(role <= 4 || role == 255, "Invalid role");

    ACLEntry[] storage acl = namedACLs[listName];
    bool found = false;

    for (uint256 i = 0; i < acl.length; i++) {
      if (acl[i].addr == addr) {
        // Update fields if not sentinel values
        if (bytes(name).length > 0 && keccak256(bytes(name)) != keccak256(bytes("\x00KEEP"))) {
          acl[i].name = name;
        }
        if (role != 255) {
          acl[i].role = role;

          // Update membership tracking
          MembershipEntry[] storage memberships = memberMemberships[addr];
          for (uint256 j = 0; j < memberships.length; j++) {
            if (keccak256(bytes(memberships[j].listName)) == keccak256(bytes(listName))) {
              memberships[j].role = role;
              break;
            }
          }
        }
        if (bytes(meta).length > 0 && keccak256(bytes(meta)) != keccak256(bytes("\x00KEEP"))) {
          acl[i].meta = meta;
        }
        found = true;
        break;
      }
    }

    require(found, "Address not in ACL");
    emit ACLModified(host, listName, addr, "update", block.timestamp);
  }

  /**
   * @dev Check if an address is in a named ACL
   * @param listName The name of the list
   * @param addr The address to check
   * @return bool True if address is in the ACL
   */
  function isInACL(string memory listName, address addr) external view returns (bool) {
    // Special handling: owner and host are always in epistery::admin
    if (keccak256(bytes(listName)) == keccak256(bytes("epistery::admin"))) {
      if (addr == owner || addr == host) {
        return true;
      }
    }

    ACLEntry[] storage acl = namedACLs[listName];
    for (uint256 i = 0; i < acl.length; i++) {
      if (acl[i].addr == addr) {
        return true;
      }
    }
    return false;
  }

  /**
   * @dev Get all entries in a named ACL
   * @param listName The name of the list
   * @return ACLEntry[] Array of ACL entries
   */
  function getACL(string memory listName) external view returns (ACLEntry[] memory) {
    ACLEntry[] storage acl = namedACLs[listName];

    // Special handling: add owner and host to epistery::admin if not already present
    if (keccak256(bytes(listName)) == keccak256(bytes("epistery::admin"))) {
      uint256 extraCount = 0;
      bool hasOwner = false;
      bool hasHost = false;

      // Check if owner/host already in list
      for (uint256 i = 0; i < acl.length; i++) {
        if (acl[i].addr == owner) hasOwner = true;
        if (acl[i].addr == host) hasHost = true;
      }

      if (!hasOwner && owner != address(0)) extraCount++;
      if (!hasHost && host != address(0) && host != owner) extraCount++;

      if (extraCount > 0) {
        ACLEntry[] memory result = new ACLEntry[](acl.length + extraCount);

        // Copy existing entries
        for (uint256 i = 0; i < acl.length; i++) {
          result[i] = acl[i];
        }

        // Add owner if missing
        uint256 idx = acl.length;
        if (!hasOwner && owner != address(0)) {
          result[idx] = ACLEntry({
            addr: owner,
            name: "Owner",
            role: 4, // owner role
            meta: '{"auto":true,"reason":"owner"}'
          });
          idx++;
        }

        // Add host if missing and different from owner
        if (!hasHost && host != address(0) && host != owner) {
          result[idx] = ACLEntry({
            addr: host,
            name: "Host",
            role: 3, // admin role
            meta: '{"auto":true,"reason":"host"}'
          });
        }

        return result;
      }
    }

    // Return regular list
    return acl;
  }

  /**
   * @dev Get all list names
   * @return string[] Array of list names
   */
  function getListNames() external view returns (string[] memory) {
    return listNames;
  }

  /**
   * @dev Get all lists a member belongs to
   * @param member The member address
   * @return MembershipEntry[] Array of memberships
   */
  function getListsForMember(address member) external view returns (MembershipEntry[] memory) {
    MembershipEntry[] memory memberships = memberMemberships[member];

    // Special handling: host and owner are always in epistery::admin
    if (member == host || member == owner) {
      // Check if epistery::admin is already in their memberships
      bool hasAdmin = false;
      for (uint256 i = 0; i < memberships.length; i++) {
        if (keccak256(bytes(memberships[i].listName)) == keccak256(bytes("epistery::admin"))) {
          hasAdmin = true;
          break;
        }
      }

      // If not already in list, add it
      if (!hasAdmin) {
        MembershipEntry[] memory result = new MembershipEntry[](memberships.length + 1);
        for (uint256 i = 0; i < memberships.length; i++) {
          result[i] = memberships[i];
        }
        result[memberships.length] = MembershipEntry({
          listName: "epistery::admin",
          role: 3, // admin role
          addedAt: 0 // special marker for implicit membership
        });
        return result;
      }
    }

    return memberships;
  }

  // ============================================================================
  // ADDRESS NAMING (decoupled from ACL / roles)
  //
  // Names belong to the address itself, not to any (address, list) join.
  // Roles are per-list (ACLEntry); names are per-address. Set name to "" to
  // clear. The ownerAddress argument on the read side is ignored (this is a
  // single-tenant contract); it's kept on the signature so that epistery's
  // Utils.ResolveAddressName works against both Agent.sol and DomainAgent.sol
  // without branching.
  // ============================================================================

  /**
   * @dev Set the human-readable name for an address.
   * @param addr The address to name
   * @param name The name string (empty string clears)
   */
  function setAddressName(address addr, string memory name) external override {
    require(msg.sender == host || msg.sender == owner, "Only host or owner can set names");
    require(addr != address(0), "Address cannot be zero");
    addressNames[addr] = name;
    emit AddressNameSet(addr, name);
  }

  /**
   * @dev Resolve an address to its name. The ownerAddress argument is
   * accepted for ABI compatibility with epistery's Agent.sol and is ignored.
   * @param addr The address to resolve
   * @return The name, or empty string if unset
   */
  function getAddressName(address /*ownerAddress*/, address addr) external view override returns (string memory) {
    return addressNames[addr];
  }

  /**
   * @dev Transfer host role to a new address (only host can call)
   * @param newHost The address of the new host
   */
  function transferHost(address newHost) external {
    require(msg.sender == host, "Only host can transfer host role");
    require(newHost != address(0), "New host cannot be zero address");
    require(newHost != host, "New host must be different from current host");

    address oldHost = host;
    host = newHost;

    emit HostTransferred(oldHost, newHost, block.timestamp);
  }

  // Events
  event HostTransferred(address indexed previousHost, address indexed newHost, uint256 timestamp);

  // ============================================================================
  // APPROVAL SYSTEM
  // ============================================================================

  struct ApprovalRequest {
    address requestor;
    string fileName;
    string fileHash;
    string message;
    uint256 timestamp;
    bool handled;
    bool approved;
  }

  // Approver => requests
  mapping(address => ApprovalRequest[]) private approvalRequests;

  /**
   * @dev Request approval from another address
   */
  function requestApproval(
    address approver,
    string memory fileName,
    string memory fileHash,
    string memory message
  ) external {
    require(approver != address(0), "Approver cannot be zero address");
    require(bytes(fileName).length > 0, "File name cannot be empty");

    approvalRequests[approver].push(ApprovalRequest({
      requestor: msg.sender,
      fileName: fileName,
      fileHash: fileHash,
      message: message,
      timestamp: block.timestamp,
      handled: false,
      approved: false
    }));

    emit ApprovalRequested(approver, msg.sender, fileName, fileHash, block.timestamp);
  }

  /**
   * @dev Handle an approval request
   */
  function handleApproval(uint256 requestIndex, bool approved) external {
    require(requestIndex < approvalRequests[msg.sender].length, "Invalid request index");

    ApprovalRequest storage request = approvalRequests[msg.sender][requestIndex];
    require(!request.handled, "Request already handled");

    request.handled = true;
    request.approved = approved;

    emit ApprovalHandled(msg.sender, request.requestor, request.fileName, approved, block.timestamp);
  }

  /**
   * @dev Get all approval requests for the caller
   */
  function getApprovalRequests() external view returns (ApprovalRequest[] memory) {
    return approvalRequests[msg.sender];
  }

  /**
   * @dev Get pending approval requests for the caller
   */
  function getPendingApprovalRequests() external view returns (ApprovalRequest[] memory) {
    ApprovalRequest[] memory allRequests = approvalRequests[msg.sender];
    uint256 pendingCount = 0;

    // Count pending requests
    for (uint256 i = 0; i < allRequests.length; i++) {
      if (!allRequests[i].handled) {
        pendingCount++;
      }
    }

    // Build pending array
    ApprovalRequest[] memory pending = new ApprovalRequest[](pendingCount);
    uint256 idx = 0;
    for (uint256 i = 0; i < allRequests.length; i++) {
      if (!allRequests[i].handled) {
        pending[idx] = allRequests[i];
        idx++;
      }
    }

    return pending;
  }

  // ============================================================================
  // INVITE SYSTEM
  // ============================================================================

  struct Invite {
    bytes32 codeHash;     // keccak256 of plaintext code
    string listName;      // ACL list (e.g. "epistery::reader")
    uint8 role;           // role to assign (1=read, 2=write, etc.)
    address createdBy;    // admin who created
    uint256 createdAt;    // block.timestamp
    bool consumed;        // single-use flag
    address consumedBy;   // redeemer address
    uint256 consumedAt;   // redemption timestamp
  }

  Invite[] private invites;
  mapping(bytes32 => uint256) private inviteIndex; // codeHash => index+1 (0 = not found)

  event InviteCreated(bytes32 indexed codeHash, string listName, uint8 role, uint256 timestamp);
  event InviteRedeemed(bytes32 indexed codeHash, address indexed redeemer, string listName, uint256 timestamp);

  /**
   * @dev Create an invite code (host or owner only)
   * @param codeHash keccak256 of the plaintext invite code
   * @param listName ACL list to add the redeemer to
   * @param role Role level to assign
   */
  function createInvite(bytes32 codeHash, string memory listName, uint8 role) external {
    require(msg.sender == host || msg.sender == owner, "Only host or owner can create invites");
    require(inviteIndex[codeHash] == 0, "Invite hash already exists");
    require(bytes(listName).length > 0, "List name cannot be empty");
    require(role <= 4, "Invalid role");

    invites.push(Invite({
      codeHash: codeHash,
      listName: listName,
      role: role,
      createdBy: msg.sender,
      createdAt: block.timestamp,
      consumed: false,
      consumedBy: address(0),
      consumedAt: 0
    }));

    inviteIndex[codeHash] = invites.length; // index+1

    emit InviteCreated(codeHash, listName, role, block.timestamp);
  }

  /**
   * @dev Redeem an invite code — atomically marks consumed AND adds to ACL
   * @param codeHash keccak256 of the plaintext invite code
   * @param redeemer Address to add to the ACL
   * @param name Display name for the ACL entry
   */
  function redeemInvite(bytes32 codeHash, address redeemer, string memory name) external {
    require(msg.sender == host || msg.sender == owner, "Only host or owner can redeem invites");
    uint256 idx = inviteIndex[codeHash];
    require(idx > 0, "Invite not found");

    Invite storage invite = invites[idx - 1];
    require(!invite.consumed, "Invite already consumed");
    require(redeemer != address(0), "Redeemer cannot be zero address");

    // Mark consumed
    invite.consumed = true;
    invite.consumedBy = redeemer;
    invite.consumedAt = block.timestamp;

    // Atomically add to ACL
    string memory meta = '{"addedBy":"invite"}';
    _addToACL(invite.listName, redeemer, name, invite.role, meta);

    emit InviteRedeemed(codeHash, redeemer, invite.listName, block.timestamp);
  }

  /**
   * @dev Revoke an unconsumed invite (host or owner only)
   * @param codeHash keccak256 of the plaintext invite code
   */
  function revokeInvite(bytes32 codeHash) external {
    require(msg.sender == host || msg.sender == owner, "Only host or owner can revoke invites");
    uint256 idx = inviteIndex[codeHash];
    require(idx > 0, "Invite not found");

    Invite storage invite = invites[idx - 1];
    require(!invite.consumed, "Invite already consumed");

    invite.consumed = true;
    invite.consumedBy = address(0); // revoked, not redeemed
    invite.consumedAt = block.timestamp;
  }

  /**
   * @dev Get invite details by hash (public — hash is opaque without plaintext)
   * @param codeHash keccak256 of the invite code
   * @return Invite struct
   */
  function getInvite(bytes32 codeHash) external view returns (Invite memory) {
    uint256 idx = inviteIndex[codeHash];
    require(idx > 0, "Invite not found");
    return invites[idx - 1];
  }

  /**
   * @dev Get all invites (host or owner only — admin listing)
   * @return Invite[] array of all invites
   */
  function getInvites() external view returns (Invite[] memory) {
    require(msg.sender == host || msg.sender == owner, "Only host or owner can list invites");
    return invites;
  }

  /**
   * @dev Export unconsumed invites for migration (host only)
   * @return Invite[] array of active invites
   */
  function exportInvites() external view returns (Invite[] memory) {
    require(msg.sender == host, "Only host can export invites");

    uint256 activeCount = 0;
    for (uint256 i = 0; i < invites.length; i++) {
      if (!invites[i].consumed) activeCount++;
    }

    Invite[] memory result = new Invite[](activeCount);
    uint256 idx = 0;
    for (uint256 i = 0; i < invites.length; i++) {
      if (!invites[i].consumed) {
        result[idx] = invites[i];
        idx++;
      }
    }
    return result;
  }

  // ============================================================================
  // ATTRIBUTE STORAGE
  // ============================================================================

  // Public attributes: owner => key => value
  mapping(address => mapping(string => string)) private publicAttributes;
  mapping(address => string[]) private publicAttributeKeys;
  address[] private publicAttributeOwners;
  mapping(address => bool) private isPublicAttributeOwner;

  // Private attributes: owner => key => value
  mapping(address => mapping(string => string)) private privateAttributes;
  mapping(address => string[]) private privateAttributeKeys;
  address[] private privateAttributeOwners;
  mapping(address => bool) private isPrivateAttributeOwner;

  /**
   * @dev Set a public attribute
   */
  function setPublicAttribute(string memory key, string memory value) external {
    require(bytes(key).length > 0, "Key cannot be empty");

    // Track owner if new
    if (!isPublicAttributeOwner[msg.sender]) {
      publicAttributeOwners.push(msg.sender);
      isPublicAttributeOwner[msg.sender] = true;
    }

    // Track key if new
    if (bytes(publicAttributes[msg.sender][key]).length == 0) {
      publicAttributeKeys[msg.sender].push(key);
    }

    publicAttributes[msg.sender][key] = value;
    emit AttributeSet(msg.sender, key, false, block.timestamp);
  }

  /**
   * @dev Get a public attribute
   */
  function getPublicAttribute(address addr, string memory key) external view returns (string memory) {
    return publicAttributes[addr][key];
  }

  /**
   * @dev Get all public attribute keys for an owner
   */
  function getPublicAttributeKeys(address addr) external view returns (string[] memory) {
    return publicAttributeKeys[addr];
  }

  /**
   * @dev Delete a public attribute
   */
  function deletePublicAttribute(string memory key) external {
    require(bytes(key).length > 0, "Key cannot be empty");
    delete publicAttributes[msg.sender][key];

    // Remove from keys array
    string[] storage keys = publicAttributeKeys[msg.sender];
    for (uint256 i = 0; i < keys.length; i++) {
      if (keccak256(bytes(keys[i])) == keccak256(bytes(key))) {
        keys[i] = keys[keys.length - 1];
        keys.pop();
        break;
      }
    }

    emit AttributeDeleted(msg.sender, key, false, block.timestamp);
  }

  /**
   * @dev Set a private attribute (only callable by owner)
   */
  function setPrivateAttribute(string memory key, string memory value) external {
    require(bytes(key).length > 0, "Key cannot be empty");

    // Track owner if new
    if (!isPrivateAttributeOwner[msg.sender]) {
      privateAttributeOwners.push(msg.sender);
      isPrivateAttributeOwner[msg.sender] = true;
    }

    // Track key if new
    if (bytes(privateAttributes[msg.sender][key]).length == 0) {
      privateAttributeKeys[msg.sender].push(key);
    }

    privateAttributes[msg.sender][key] = value;
    emit AttributeSet(msg.sender, key, true, block.timestamp);
  }

  /**
   * @dev Get a private attribute (only owner can read their own)
   */
  function getPrivateAttribute(string memory key) external view returns (string memory) {
    return privateAttributes[msg.sender][key];
  }

  /**
   * @dev Get all private attribute keys (only owner can see their own)
   */
  function getPrivateAttributeKeys() external view returns (string[] memory) {
    return privateAttributeKeys[msg.sender];
  }

  /**
   * @dev Delete a private attribute
   */
  function deletePrivateAttribute(string memory key) external {
    require(bytes(key).length > 0, "Key cannot be empty");
    delete privateAttributes[msg.sender][key];

    // Remove from keys array
    string[] storage keys = privateAttributeKeys[msg.sender];
    for (uint256 i = 0; i < keys.length; i++) {
      if (keccak256(bytes(keys[i])) == keccak256(bytes(key))) {
        keys[i] = keys[keys.length - 1];
        keys.pop();
        break;
      }
    }

    emit AttributeDeleted(msg.sender, key, true, block.timestamp);
  }

  // ============================================================================
  // MIGRATION EXPORT
  // ============================================================================

  struct MigrationACL {
    string listName;
    ACLEntry[] entries;
  }

  struct MigrationAttributes {
    address addr;
    string[] keys;
    string[] values;
  }

  /**
   * @dev Export all contract data for migration to a new contract.
   * Only the host or a contract with the same host can call this.
   */
  function exportForMigration() external view returns (
    MigrationACL[] memory acls,
    MigrationAttributes[] memory publicAttrs,
    MigrationAttributes[] memory privateAttrs
  ) {
    // Auth: host directly, or a contract with same host
    bool authorized = msg.sender == host;
    if (!authorized) {
      try DomainAgent(msg.sender).host() returns (address callerHost) {
        authorized = (callerHost == host);
      } catch {}
    }
    require(authorized, "Only host or same-host contract can export");

    // 1. Export ACLs — raw storage entries (no auto-generated owner/host)
    acls = new MigrationACL[](listNames.length);
    for (uint i = 0; i < listNames.length; i++) {
      acls[i].listName = listNames[i];
      acls[i].entries = namedACLs[listNames[i]];
    }

    // 2. Export public attributes for all tracked owners
    publicAttrs = new MigrationAttributes[](publicAttributeOwners.length);
    for (uint i = 0; i < publicAttributeOwners.length; i++) {
      address addr = publicAttributeOwners[i];
      string[] storage keys = publicAttributeKeys[addr];
      publicAttrs[i].addr = addr;
      publicAttrs[i].keys = keys;
      publicAttrs[i].values = new string[](keys.length);
      for (uint j = 0; j < keys.length; j++) {
        publicAttrs[i].values[j] = publicAttributes[addr][keys[j]];
      }
    }

    // 3. Export private attributes for all tracked owners
    privateAttrs = new MigrationAttributes[](privateAttributeOwners.length);
    for (uint i = 0; i < privateAttributeOwners.length; i++) {
      address addr = privateAttributeOwners[i];
      string[] storage keys = privateAttributeKeys[addr];
      privateAttrs[i].addr = addr;
      privateAttrs[i].keys = keys;
      privateAttrs[i].values = new string[](keys.length);
      for (uint j = 0; j < keys.length; j++) {
        privateAttrs[i].values[j] = privateAttributes[addr][keys[j]];
      }
    }
  }

  // ============================================================================
  // COMPATIBILITY ALIASES (for old epistery-host calling old Agent.sol methods)
  // ============================================================================

  /**
   * @dev Compatibility: old Agent.sol signature with owner parameter (ignored)
   */
  function isWhitelisted(address /*owner*/, string memory listName, address addr) external view returns (bool) {
    return this.isInACL(listName, addr);
  }

  /**
   * @dev Compatibility: old Agent.sol signature with owner parameter (ignored)
   */
  function getWhitelist(address /*owner*/, string memory listName) external view returns (ACLEntry[] memory) {
    return this.getACL(listName);
  }

  /**
   * @dev Compatibility: old Agent.sol signature with owner parameter (ignored)
   */
  function getListsForOwner(address /*owner*/) external view returns (string[] memory) {
    return this.getListNames();
  }
}
