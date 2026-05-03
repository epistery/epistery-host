#!/usr/bin/env node
/**
 * migrate-acl-keys.mjs
 *
 * One-time migration: copies on-chain ACL data from @org/name keys to org/name keys.
 * Run once per deployment after updating DomainAcl's normalizeAgentName().
 *
 * Usage:
 *   node migrate-acl-keys.mjs                    # migrate all domains with contracts
 *   node migrate-acl-keys.mjs geist.social       # migrate a specific domain
 *   node migrate-acl-keys.mjs --dry-run          # show what would be migrated
 */
import { Config } from 'epistery';
import { DomainChain } from './utils/DomainChain.mjs';
import { readdirSync, statSync, readlinkSync } from 'fs';
import path from 'path';

const AGENTS_DIR = path.join(process.env.HOME, '.epistery', '.agents');
const EPISTERY_DIR = path.join(process.env.HOME, '.epistery');

// Agent names and attribute keys that might have on-chain data (old @-prefixed format)
const KNOWN_AGENTS = [
    '@epistery/wiki',
    '@epistery/files',
    '@epistery/message-board',
    '@epistery/mimi',
    '@epistery/connector',
    '@epistery/publisher',
    '@epistery/registry',
    '@epistery/relay',
    '@epistery/scan',
    '@epistery/mail',
    '@epistery/pinapp',
    '@epistery/pinapp/impl',
    '@epistery/pinapp/factory',
    '@rootz/secret-agent',
    '@epistery/secret-agent',
    '@rootz/ai-discovery',
    '@geistm/adnet-agent',
    '@geistm/scout',
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const specificDomain = args.find(a => !a.startsWith('--'));

async function getDomains() {
    if (specificDomain) return [specificDomain];

    const entries = readdirSync(EPISTERY_DIR);
    const domains = [];
    for (const entry of entries) {
        const full = path.join(EPISTERY_DIR, entry);
        try {
            if (!statSync(full).isDirectory()) continue;
        } catch { continue; }
        // Skip internal directories
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        // Must have a config.ini to be a real domain
        try {
            const cfg = new Config();
            cfg.setPath(entry);
            if (cfg.data.contract_address) {
                domains.push(entry);
            }
        } catch { /* skip */ }
    }
    return domains;
}

async function migrateDomain(domain) {
    console.log(`\n── ${domain} ──`);

    const chain = new DomainChain(domain);
    const contract = chain.contract;
    if (!contract) {
        console.log('  No contract deployed, skipping.');
        return;
    }

    const signerAddress = await contract.signer.getAddress();
    let migrated = 0;

    for (const oldName of KNOWN_AGENTS) {
        const newName = oldName.replace(/^@/, '');

        try {
            // Read old key
            const oldData = await contract.getPublicAttribute(signerAddress, oldName);
            if (!oldData) continue;

            // Check if new key already has data
            const newData = await contract.getPublicAttribute(signerAddress, newName);
            if (newData) {
                console.log(`  ${oldName} → ${newName}: already migrated`);
                continue;
            }

            if (dryRun) {
                console.log(`  ${oldName} → ${newName}: would migrate (${oldData.length} bytes)`);
                migrated++;
                continue;
            }

            // Write under new key
            const feeData = await chain.getFeeData();
            const tx = await contract.setPublicAttribute(newName, oldData, feeData);
            await tx.wait();
            console.log(`  ${oldName} → ${newName}: migrated (tx: ${tx.hash})`);
            migrated++;
        } catch (err) {
            console.error(`  ${oldName} → ${newName}: ERROR ${err.message}`);
        }
    }

    if (migrated === 0) {
        console.log('  Nothing to migrate.');
    } else {
        console.log(`  ${migrated} key(s) ${dryRun ? 'would be' : ''} migrated.`);
    }
}

async function main() {
    console.log(dryRun ? '=== DRY RUN ===' : '=== ACL Key Migration ===');
    console.log('Migrating on-chain keys from @org/name → org/name\n');

    const domains = await getDomains();
    console.log(`Domains to process: ${domains.join(', ') || '(none)'}`);

    for (const domain of domains) {
        await migrateDomain(domain);
    }

    console.log('\nDone.');
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
