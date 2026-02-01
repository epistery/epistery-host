// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title DomainAgent
 * @dev Domain-bound access control and data management contract
 *
 * A DomainAgent is bound to a domain name and provides:
 * - Named access control lists (ACLs) with role-based permissions
 * - Public and private attribute storage
 * - Approval workflow system
 *
 * The sponsor (contract deployer) and owner automatically have admin access.
 */
contract DomainAgent {
  // Contract version
  string public constant VERSION = "1.0.3";

  // Domain this contract serves
  string public domain;

  // Contract sponsor (paid deployment fee)
  address public sponsor;

  // Contract owner (defaults to sponsor, can be transferred)
  address public owner;

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

  // Events
  event ACLModified(address indexed owner, string listName, address indexed addr, string action, uint256 timestamp);
  event ApprovalRequested(address indexed approver, address indexed requestor, string fileName, string fileHash, uint256 timestamp);
  event ApprovalHandled(address indexed approver, address indexed requestor, string fileName, bool approved, uint256 timestamp);
  event AttributeSet(address indexed owner, string key, bool isPrivate, uint256 timestamp);
  event AttributeDeleted(address indexed owner, string key, bool isPrivate, uint256 timestamp);

  // ============================================================================
  // CONSTRUCTOR
  // ============================================================================

  constructor(string memory _domain, address _sponsor, address _owner) {
    require(bytes(_domain).length > 0, "Domain cannot be empty");
    require(_sponsor != address(0), "Sponsor cannot be zero address");
    domain = _domain;
    sponsor = _sponsor;
    owner = _owner != address(0) ? _owner : _sponsor;
  }

  // ============================================================================
  // ACL MANAGEMENT
  // ============================================================================

  /**
   * @dev Add an address to a named ACL (only owner or sponsor)
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
    require(msg.sender == owner || msg.sender == sponsor, "Only owner or sponsor can modify ACL");
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

    emit ACLModified(owner, listName, addressToAdd, "add", block.timestamp);
  }

  /**
   * @dev Remove an address from a named ACL (only owner or sponsor)
   * @param listName The name of the list
   * @param addressToRemove The address to remove
   */
  function removeFromACL(string memory listName, address addressToRemove) external {
    require(msg.sender == owner || msg.sender == sponsor, "Only owner or sponsor can modify ACL");
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

    emit ACLModified(owner, listName, addressToRemove, "remove", block.timestamp);
  }

  /**
   * @dev Update an ACL entry's metadata (only owner or sponsor)
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
    require(msg.sender == owner || msg.sender == sponsor, "Only owner or sponsor can modify ACL");
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
    emit ACLModified(owner, listName, addr, "update", block.timestamp);
  }

  /**
   * @dev Check if an address is in a named ACL
   * @param listName The name of the list
   * @param addr The address to check
   * @return bool True if address is in the ACL
   */
  function isInACL(string memory listName, address addr) external view returns (bool) {
    // Special handling: sponsor and owner are always in epistery::admin
    if (keccak256(bytes(listName)) == keccak256(bytes("epistery::admin"))) {
      if (addr == sponsor || addr == owner) {
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

    // Special handling: add sponsor and owner to epistery::admin if not already present
    if (keccak256(bytes(listName)) == keccak256(bytes("epistery::admin"))) {
      uint256 extraCount = 0;
      bool hasSponsor = false;
      bool hasOwner = false;

      // Check if sponsor/owner already in list
      for (uint256 i = 0; i < acl.length; i++) {
        if (acl[i].addr == sponsor) hasSponsor = true;
        if (acl[i].addr == owner) hasOwner = true;
      }

      if (!hasSponsor && sponsor != address(0)) extraCount++;
      if (!hasOwner && owner != address(0) && owner != sponsor) extraCount++;

      if (extraCount > 0) {
        ACLEntry[] memory result = new ACLEntry[](acl.length + extraCount);

        // Copy existing entries
        for (uint256 i = 0; i < acl.length; i++) {
          result[i] = acl[i];
        }

        // Add sponsor if missing
        uint256 idx = acl.length;
        if (!hasSponsor && sponsor != address(0)) {
          result[idx] = ACLEntry({
            addr: sponsor,
            name: "Sponsor",
            role: 4, // owner role
            meta: '{"auto":true,"reason":"sponsor"}'
          });
          idx++;
        }

        // Add owner if missing and different from sponsor
        if (!hasOwner && owner != address(0) && owner != sponsor) {
          result[idx] = ACLEntry({
            addr: owner,
            name: "Owner",
            role: 3, // admin role
            meta: '{"auto":true,"reason":"owner"}'
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

    // Special handling: owner and sponsor are always in epistery::admin
    if (member == owner || member == sponsor) {
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

  /**
   * @dev Transfer ownership to a new address (only owner can call)
   * @param newOwner The address of the new owner
   */
  function transferOwnership(address newOwner) external {
    require(msg.sender == owner, "Only owner can transfer ownership");
    require(newOwner != address(0), "New owner cannot be zero address");
    require(newOwner != owner, "New owner must be different from current owner");

    address oldOwner = owner;
    owner = newOwner;

    emit OwnershipTransferred(oldOwner, newOwner, block.timestamp);
  }

  // Events
  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner, uint256 timestamp);

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
  // ATTRIBUTE STORAGE
  // ============================================================================

  // Public attributes: owner => key => value
  mapping(address => mapping(string => string)) private publicAttributes;
  mapping(address => string[]) private publicAttributeKeys;

  // Private attributes: owner => key => value
  mapping(address => mapping(string => string)) private privateAttributes;
  mapping(address => string[]) private privateAttributeKeys;

  /**
   * @dev Set a public attribute
   */
  function setPublicAttribute(string memory key, string memory value) external {
    require(bytes(key).length > 0, "Key cannot be empty");

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
