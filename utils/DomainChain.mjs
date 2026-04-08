import {Config} from "epistery";
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
  get provider() {
    if (!this._provider) {
      const rpc = this.config.data.provider.rpc;
      const chainId = parseInt(this.config.data.provider.chainId);
      const key = `${rpc}:${chainId}`;
      if (!DomainChain._providers.has(key)) {
        DomainChain._providers.set(key, new ethers.providers.JsonRpcProvider(rpc, {
          chainId,
          name: this.config.data.provider.name
        }));
      }
      this._provider = DomainChain._providers.get(key);
    }
    return this._provider;
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
      const raw = new ethers.Contract(this.contractAddress, this.artifact.abi, this.wallet);
      this._contract = this._wrapContractWithFeeData(raw);
    }
    return this._contract;
  }

  /**
   * Wrap an ethers.Contract so every state-mutating method automatically
   * appends our computed feeData (from getFeeData()) as the transaction
   * overrides argument. Without this, raw `contract.someWrite(args)` calls
   * use ethers' defaults — which on Polygon mainnet are 1.5 gwei priority
   * fee, below the network's 25 gwei minimum, and every tx is rejected.
   *
   * Callers that already pass a transaction overrides object as the last
   * argument keep working: explicit fields win, and our feeData is merged
   * underneath as defaults. View/pure functions are passed through.
   */
  _wrapContractWithFeeData(rawContract) {
    const isOverridesObj = (x) =>
      x && typeof x === 'object' && !Array.isArray(x) && !ethers.BigNumber.isBigNumber(x) && (
        'gasPrice' in x || 'maxFeePerGas' in x || 'maxPriorityFeePerGas' in x ||
        'gasLimit' in x || 'nonce' in x || 'value' in x || 'from' in x || 'type' in x
      );

    // Identify state-mutating functions from the ABI.
    const writeFns = new Set();
    for (const item of this.artifact.abi) {
      if (item.type !== 'function') continue;
      if (item.stateMutability === 'view' || item.stateMutability === 'pure') continue;
      writeFns.add(item.name);
    }

    // Replace each write function on the contract with a wrapper.
    for (const name of writeFns) {
      const original = rawContract[name];
      if (typeof original !== 'function') continue;
      const getFee = () => this.getFeeData();
      rawContract[name] = async function(...args) {
        let overrides;
        if (args.length > 0 && isOverridesObj(args[args.length - 1])) {
          // Caller-supplied overrides win; our feeData fills in any blanks.
          const fee = await getFee();
          overrides = { ...fee, ...args[args.length - 1] };
          args[args.length - 1] = overrides;
        } else {
          overrides = await getFee();
          args.push(overrides);
        }
        return original.apply(rawContract, args);
      };
    }

    return rawContract;
  }
  async getFeeData() {
    const feeData = await this.provider.getFeeData();
    // Use network gasPrice as floor — some chains (JOC) have near-zero baseFee
    // but high minimum gas price, so EIP-1559 computed values are too low
    const minGasPrice = feeData.gasPrice || ethers.utils.parseUnits("30", "gwei");
    const networkPriority = feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas.mul(120).div(100) : minGasPrice;
    const maxPriorityFeePerGas = networkPriority.gt(minGasPrice) ? networkPriority : minGasPrice;
    const networkMax = feeData.maxFeePerGas ? feeData.maxFeePerGas.mul(120).div(100) : minGasPrice.mul(2);
    const maxFeePerGas = networkMax.gt(minGasPrice.mul(2)) ? networkMax : minGasPrice.mul(2);
    return { maxPriorityFeePerGas, maxFeePerGas }
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
