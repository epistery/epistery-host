import {Config, chainFor, configuredChains} from "epistery";
import ethers from "ethers";
import path from 'path';
import { readFileSync } from 'fs';
import {createRequire} from "module";
import {fileURLToPath} from "url";
import { S3Client, ListObjectsV2Command, CopyObjectCommand } from '@aws-sdk/client-s3';
import { retryWithBackoff } from './retryWithBackoff.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class DomainChain {
  // Cache RPC providers by endpoint URL to avoid recreating per request
  static _providers = new Map();
  constructor(domain) {
    this.domain = domain;
    this.config = new Config();
    this.config.setPath(domain);
  }
  get artifact() {
    if (!this._artifact) {
      this._artifact = JSON.parse(
        readFileSync(path.join(__dirname, '../artifacts/contracts/DomainAgent.sol/DomainAgent.json'), 'utf8')
      );
    }
    return this._artifact;
  }
  /** Chain object — owns the provider, fee policy, and contract wrapping. */
  get chain() {
    if (!this._chain) {
      const p = { ...this.config.data.provider };
      const entry = configuredChains().find(c => String(c.chainId) === String(p.chainId));
      if (entry?.privateRpc) p.privateRpc = entry.privateRpc;
      this._chain = chainFor(p);
    }
    return this._chain;
  }
  get provider() {
    return this.chain.provider;
  }
  get wallet() {
    if (!this._wallet) {
      this._wallet = ethers.Wallet.fromMnemonic(this.config.data.wallet.mnemonic).connect(this.provider);
    }
    return this._wallet;
  }
  get contract() {
    if (!this._contract) {
      this.contractAddress = this.config.data.contract_address;
      if (!this.contractAddress) return null;
      this._contract = new ethers.Contract(this.contractAddress, this.artifact.abi, this.wallet);
    }
    return this._contract;
  }
  async getFeeData() {
    return this.chain.getFeeData();
  }

  /**
   * Migrate all data from an old contract to a new one.
   * Handles ACLs, public/private attributes, and Storj storage.
   * @param {string} oldContractAddress - address of the previous contract
   * @param {ethers.Contract} newContract - the newly deployed contract instance
   * @param {string} ownerAddress - owner/admin address (skip in ACL migration)
   * @param {object} txOverrides - gas fee overrides {maxPriorityFeePerGas, maxFeePerGas}
   */
  async migrateContract(oldContractAddress, newContract, ownerAddress, txOverrides) {
    const walletAddress = this.wallet.address;
    const newContractAddress = newContract.address;

    console.log(`[deploy] Migrating data from old contract ${oldContractAddress}...`);
    const oldContract = new ethers.Contract(oldContractAddress, this.artifact.abi, this.wallet);

    let acls, publicAttrs, privateAttrs;

    // Try the comprehensive export first (v1.1.0+)
    try {
      [acls, publicAttrs, privateAttrs] = await retryWithBackoff(() =>
        oldContract.exportForMigration()
      );
      console.log(`[deploy] Export: ${acls.length} ACL lists, ${publicAttrs.length} public attr owners, ${privateAttrs.length} private attr owners`);
    } catch {
      console.log(`[deploy] Old contract lacks exportForMigration, using individual getters`);
      acls = null;
    }

    // 1. Migrate ACL lists
    try {
      const lists = acls
        ? acls
        : await (async () => {
            const names = await retryWithBackoff(() => oldContract.getListNames());
            const result = [];
            for (const name of names) {
              const entries = await retryWithBackoff(() => oldContract.getACL(name));
              result.push({ listName: name, entries });
            }
            return result;
          })();

      for (const list of lists) {
        for (const entry of list.entries) {
          try { if (JSON.parse(entry.meta)?.auto) continue; } catch {}
          if (entry.addr === walletAddress || entry.addr === ownerAddress) continue;
          try {
            const tx = await newContract.addToACL(
              list.listName, entry.addr, entry.name, entry.role, entry.meta, txOverrides
            );
            await tx.wait();
            console.log(`[deploy] Migrated ACL: ${list.listName} → ${entry.name || entry.addr}`);
          } catch (err) {
            console.warn(`[deploy] ACL entry ${entry.addr} in ${list.listName}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[deploy] ACL migration failed: ${err.message}`);
    }

    // 2. Migrate public attributes
    try {
      const attrSets = publicAttrs
        ? publicAttrs
        : await (async () => {
            const keys = await retryWithBackoff(() =>
              oldContract.getPublicAttributeKeys(walletAddress)
            );
            const values = [];
            for (const key of keys) {
              values.push(await retryWithBackoff(() =>
                oldContract.getPublicAttribute(walletAddress, key)
              ));
            }
            return [{ addr: walletAddress, keys, values }];
          })();

      for (const attrSet of attrSets) {
        for (let i = 0; i < attrSet.keys.length; i++) {
          if (!attrSet.values[i]) continue;
          if (attrSet.addr !== walletAddress) {
            console.warn(`[deploy] Skipping public attrs for ${attrSet.addr} (not server wallet)`);
            continue;
          }
          try {
            const tx = await newContract.setPublicAttribute(
              attrSet.keys[i], attrSet.values[i], txOverrides
            );
            await tx.wait();
            console.log(`[deploy] Migrated public attr: ${attrSet.keys[i]}`);
          } catch (err) {
            console.warn(`[deploy] Public attr ${attrSet.keys[i]}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[deploy] Public attribute migration failed: ${err.message}`);
    }

    // 3. Migrate private attributes
    try {
      const attrSets = privateAttrs
        ? privateAttrs
        : await (async () => {
            const keys = await retryWithBackoff(() => oldContract.getPrivateAttributeKeys());
            const values = [];
            for (const key of keys) {
              values.push(await retryWithBackoff(() =>
                oldContract.getPrivateAttribute(key)
              ));
            }
            return [{ addr: walletAddress, keys, values }];
          })();

      for (const attrSet of attrSets) {
        for (let i = 0; i < attrSet.keys.length; i++) {
          if (!attrSet.values[i]) continue;
          if (attrSet.addr !== walletAddress) {
            console.warn(`[deploy] Skipping private attrs for ${attrSet.addr} (not server wallet)`);
            continue;
          }
          try {
            const tx = await newContract.setPrivateAttribute(
              attrSet.keys[i], attrSet.values[i], txOverrides
            );
            await tx.wait();
            console.log(`[deploy] Migrated private attr: ${attrSet.keys[i]}`);
          } catch (err) {
            console.warn(`[deploy] Private attr ${attrSet.keys[i]}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.warn(`[deploy] Private attribute migration failed: ${err.message}`);
    }

    // 4. Migrate Storj storage
    // Privatized domains have their own Storj project — data is unaffected by contract changes.
    // Only shared-project domains need object copying from old to new contract prefix.
    try {
      if (this.config.data.storj_private?.ACCESS_KEY) {
        console.log(`[deploy] Storj: privatized storage, no object migration needed`);
      } else {
        const rootCfg = new Config();
        const storjConfig = this.config.data.storj || rootCfg.data?.storj;
        if (storjConfig?.ACCESS_KEY && storjConfig?.SECRET_KEY && storjConfig?.ENDPOINT && storjConfig?.BUCKET) {
          const s3 = new S3Client({
            endpoint: storjConfig.ENDPOINT,
            region: 'us-east-1',
            credentials: {
              accessKeyId: storjConfig.ACCESS_KEY,
              secretAccessKey: storjConfig.SECRET_KEY
            },
            forcePathStyle: true
          });
          const bucket = storjConfig.BUCKET;
          const oldPrefix = `${oldContractAddress}/`;
          const newPrefix = `${newContractAddress}/`;

          let continuationToken;
          let totalCopied = 0;
          do {
            const listCmd = new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: oldPrefix,
              ContinuationToken: continuationToken
            });
            const listResponse = await s3.send(listCmd);
            const objects = listResponse.Contents || [];

            for (const obj of objects) {
              const relativePath = obj.Key.substring(oldPrefix.length);
              const newKey = newPrefix + relativePath;
              try {
                await s3.send(new CopyObjectCommand({
                  Bucket: bucket,
                  CopySource: `${bucket}/${obj.Key}`,
                  Key: newKey
                }));
                totalCopied++;
              } catch (copyErr) {
                console.warn(`[deploy] Storj copy failed: ${obj.Key} → ${newKey}: ${copyErr.message}`);
              }
            }

            continuationToken = listResponse.IsTruncated ? listResponse.NextContinuationToken : undefined;
          } while (continuationToken);

          if (totalCopied > 0) {
            console.log(`[deploy] Storj: copied ${totalCopied} objects from ${oldPrefix} to ${newPrefix}`);
          } else {
            console.log(`[deploy] Storj: no objects found under ${oldPrefix}`);
          }
        } else {
          console.log(`[deploy] Storj not configured, skipping storage migration`);
        }
      }
    } catch (err) {
      console.warn(`[deploy] Storj migration failed: ${err.message}`);
    }

    // 5. Migrate active invites (v1.3.0+)
    try {
      const inviteData = await retryWithBackoff(() => oldContract.exportInvites());
      for (const invite of inviteData) {
        if (invite.consumed) continue;
        try {
          const tx = await newContract.createInvite(invite.codeHash, invite.listName, invite.role, txOverrides);
          await tx.wait();
          console.log(`[deploy] Migrated invite: ${invite.codeHash.substring(0, 10)}... → ${invite.listName}`);
        } catch (err) {
          console.warn(`[deploy] Invite migration: ${err.message}`);
        }
      }
    } catch {
      console.log('[deploy] No invites to migrate (old contract may lack exportInvites)');
    }

    console.log(`[deploy] Migration from ${oldContractAddress} complete`);
  }
}
