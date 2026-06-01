// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title IAddressNaming
 * @notice Canonical interface for resolving identity names from addresses.
 *
 * Names belong to the address itself, not to any (address, list) join.
 * Roles ("owner", "admin", "read", ...) remain on whitelist / ACL entries;
 * names do not.
 *
 * Single-tenant implementations (epistery-host's DomainAgent.sol) accept the
 * read's ownerAddress argument on the signature for ABI compatibility but
 * ignore it; writes are admin-gated.
 *
 * Previously provided by the epistery package's synthesized contracts/. As of
 * epistery 2.0.0 the package is identity-only and ships no contracts, so the
 * host owns this interface — its own DomainAgent is the implementation.
 */
interface IAddressNaming {
    /**
     * @notice Set the human-readable name for an address.
     * @param addr The address to name
     * @param name The name string; empty string clears
     */
    function setAddressName(address addr, string memory name) external;

    /**
     * @notice Resolve an address to its name.
     * @param ownerAddress The naming-scope owner; ignored by single-tenant
     *        implementations, used by multi-tenant ones
     * @param addr The address to resolve
     * @return The name, or empty string if unset
     */
    function getAddressName(address ownerAddress, address addr) external view returns (string memory);
}
