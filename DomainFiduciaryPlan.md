# Domain Fiduciary — Draft Plan (2026-07-24, rev 3)

**Status:** Draft — open questions answered per Michael's direction, for final review · Michael + Claude session
**Problem owner:** epistery-host
**Companion context:** adnet test bench (geist.social wiki: AdnetTestBench), `workspace/geistm/ADNET-TODO.md`

## Problem

Each hosted domain has a server wallet AND a DomainAgent contract, but no
constructor whereby the contract assumes the fiduciary role of its creator.
Today the EOA server wallet is the fiduciary — verified on-chain 2026-07-23:
every adnet CampaignContract's advertiser is `{name: <domain>, wallet: <that
domain's server wallet>}` (geist.social → 0x0deD…93c0, michael.sprague.com →
0x76f6…C627, host.mespr.me → 0x0c0E…063c). The contract is only ACL
bookkeeping. The owner should be the domain, not a bare key.

## Lineage review (what already exists)

- **rootz-v6 (original):** IdentityContractV3 + IdentityFactory_V6.mintFor —
  the assume-the-role constructor pattern (atomic deploy + bind creator +
  transfer ownership) and the **credits economy** (UniversalTeamRegistry
  lineage, rate tables, relay billing).
- **epistery/relay:** the packaging rails — pool wallet pays gas, bills
  credits from the Registry, mints identities on behalf of users who sign
  nothing on-chain. The relay is the batching/packaging primitive adnet's
  settlement model wants ("joe-net" = anyone running a relay).
- **epistery/app (current generation):** its own `IdentityContract.sol`,
  derived from the original — *"a collection of devices that IS an identity;
  a multisig smart wallet whose signers (rivets) are interchangeable
  owners."* Single-tx constructor `(firstRivet, host, firstRivetName,
  firstRivetPubKey, displayName)`; `executeTransaction`/`sendETH`/`sendToken`;
  **ERC-1271** (`isValidSignature` — a rivet's signature validates as the
  contract's); host = a revocable recovery rivet with no special power; N-of-M
  governance knob; and **`EpisteryAccess`** — explicitly "the one ACL-and-data
  primitive shared by IdentityContract, DomainAgent, and CampaignContract,"
  where each concrete contract defines its stewards via `_isSteward` (rivets /
  owner+host / advertiser+agency).

**Decision:** the domain fiduciary is an **app-lineage IdentityContract
minted for the domain**. No new fiduciary Solidity; DomainAgent stays the
host-plugin ACL (standing rule: DomainAgent and IdentityContract remain
separate contracts — EpisteryAccess is the sanctioned shared *mechanism*).

## The constructor (what epistery-host adds)

A fourth domain lifecycle state and the flow to reach it:

1. **Unclaimed → Claimed → Initialized** (unchanged).
2. **→ Fiduciary**: initialize page + MCP tool offer *Mint domain identity* —
   a single deploy tx of the app-lineage IdentityContract:
   - `firstRivet` = the domain **server wallet** (the creator whose fiduciary
     role the contract assumes)
   - `host` = recovery rivet: the domain **owner (admin) wallet** — so the
     human who claimed the domain can always recover it; revocable for full
     self-sovereignty
   - `displayName` = the domain name (world-readable PROFILE section)
   - minted via the relay (pool pays gas, credits-billed) or by the server
     wallet directly for self-funded domains
3. Config records `identity_contract`; `epistery info` reports it. The
   domain's **fiduciary address is the IdentityContract**.
4. Operators are rivets — rotation/revocation are rivet operations; custody
   never moves. `removeRivetThreshold` is the governance knob.

## What ERC-1271 buys: one address for identity AND transactions

Because the contract validates rivet signatures as its own, the domain
identity can be the **signer of record at both layers** of the adnet model:

- *Identity signatures:* `/.well-known/ai` `_signature.digitalName` can name
  the contract; verifiers accept a rivet-signed manifest via ERC-1271. The
  current two-wallet split (digitalName wallet vs operational server wallet)
  collapses into one address without unifying any contracts.
- *Transaction signatures:* campaigns name the contract as
  `advertiser.wallet`; pause/fund/withdraw arrive via `executeTransaction`
  (`msg.sender` = the identity) — existing CampaignContract gates match
  unchanged.

Sections give the rest for free: the domain's adnet config (creative folder,
settlement policy) can live as a section on the domain identity with its own
ACL, per the EpisteryAccess design.

## Prerequisite: the proven-control-set fix

The known owner-ACL-lockout (2026-06-26, persists in 2.1) is a hard blocker:
the moment the server wallet binds a domain IdentityContract, host-side
interpreters keying on a single `identityAddress` would 403 the domain out of
its own plugins. The specified fix — authorize against the SET of
proven-control addresses {signer EOA, bound contract}, `max` ACL level, in
epistery-host `DomainACL` (the interpreter, not the authority) — must land
**before** the first domain mints. (Note the app contract already anticipates
this: `_isSteward` treats `address(this)` as steward because callers arrive
under their canonical identityAddress.)

## Adnet integration (consumes this)

- New campaigns: `advertiser.wallet` = domain IdentityContract. Existing
  gates match; "abandon and recreate" retires the EOA-owned generation free.
- Factory alignment (ADNET-TODO): requireSponsor accepts a caller who
  provably controls the advertiser identity (same proven-control set), or a
  relay-forwarded `executeTransaction` arriving AS the identity.
- CampaignContract v-next adopts `EpisteryAccess` (stewards =
  advertiser/agency) per that base's stated design — folds into the
  "factory hasn't considered its keys/core since inception" adaptation.

## Decisions (2026-07-24)

1. **Mint path: epistery-host deploys directly with the server wallet**, the
   same way it already deploys DomainAgent (balance check, gas estimate,
   single deploy tx). No relay dependency in the host's core lifecycle — no
   extra layers. The relay/credits path becomes an *alternative* for hosted
   tenants who'd rather spend credits than hold POL, added later without
   changing the contract or the flow.
2. **One-rivet-one-contract is respected — the owner's personal wallet is NOT
   a rivet.** Founding roster: firstRivet = the domain server wallet;
   recovery host rivet = the **epistery-host platform wallet**, exactly the
   role the contract's own header documents ("e.g. epistery-host"), and
   recovery-only by policy — it never operates (the host-operator write
   collision taught this). The owner exercises control the multisig way:
   ACL'd admin driving the host, which signs via the server-wallet rivet. A
   domain wanting self-sovereignty adds a dedicated rivet of its own and may
   revoke the host rivet.
3. **Rivet is a stricter grant than admin.** Admins manage — plugins, ACLs,
   content — via DomainAgent. Only rivets move funds or sign as the identity.
   A bot can hold admin everywhere and still spend nowhere; spend is granted
   by rivet ceremony, separately.
4. **N-of-M: 1-of-M for operations by default** — the machine is never gated
   at alpha; trust is measurement, not gates. A disburse threshold is
   **declared on-chain as a public attribute of the identity's policy
   section** and **enforced by the surfaces** (host, relay) — the same
   declare/enforce split the CampaignContract settlement rule already uses.
   Contract-level enforcement is a later hardening, not a blocker.
5. **digitalName migration: the contract address becomes the digitalName.**
   The manifest is re-signed by a rivet and validates via ERC-1271; scan
   re-indexes and records the old EOA digitalName as an **alias** on the
   entity so history and reputation carry over (and the domain naturally
   reaches the chain-bound rung: contractExists + domainBinding). Prove the
   whole migration on the test-bench publishers first, then real domains.
