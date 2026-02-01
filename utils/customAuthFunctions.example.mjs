/**
 * Custom Authentication Functions - Example implementations
 *
 * Custom auth functions receive:
 * @param {string} userAddress - User's wallet address
 * @param {string} domain - Domain name
 * @param {Config} cfg - Config instance for the domain
 * @returns {Promise<{allowed: boolean, level: number}>}
 *
 * Access levels:
 * 0 = None (denied)
 * 1 = Read
 * 2 = Write
 * 3 = Admin
 *
 * To use these functions:
 * 1. Copy this file to your agent directory and rename it (e.g., auth.mjs)
 * 2. Implement your custom functions
 * 3. Import and pass them to agentAccessMiddleware in your agent's index.mjs
 *
 * Example usage in agent index.mjs:
 * ```
 * import { agentAccessMiddleware } from '../epistery-host/acl.mjs';
 * import * as customAuth from './auth.mjs';
 *
 * router.use(agentAccessMiddleware('myagent', customAuth));
 * ```
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ethers = require('ethers');

/**
 * Example: Check if user holds minimum token balance
 * This checks RVT token balance on Polygon
 */
export async function checkTokenBalance(userAddress, domain, cfg) {
    try {
        const provider = cfg.data?.provider;
        if (!provider || !provider.rpc) {
            console.error('[checkTokenBalance] Provider not configured');
            return { allowed: false, level: 0 };
        }

        const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);

        // RVT token contract address on Polygon
        const tokenAddress = '0x4c3bF0a3DE9524aF68327d1D2558a3B70d17D42a'; // Replace with actual RVT address
        const minBalance = ethers.utils.parseUnits('10', 18); // Require 10 RVT

        // ERC20 ABI (balanceOf only)
        const tokenAbi = [
            'function balanceOf(address owner) view returns (uint256)'
        ];

        const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, ethersProvider);
        const balance = await tokenContract.balanceOf(userAddress);

        if (balance.gte(minBalance)) {
            // User has enough tokens - grant read access
            return { allowed: true, level: 1 };
        }

        return { allowed: false, level: 0 };
    } catch (error) {
        console.error('[checkTokenBalance] Error:', error);
        return { allowed: false, level: 0 };
    }
}

/**
 * Example: Check if user holds any NFT from a collection
 */
export async function checkNFTOwnership(userAddress, domain, cfg) {
    try {
        const provider = cfg.data?.provider;
        if (!provider || !provider.rpc) {
            return { allowed: false, level: 0 };
        }

        const ethersProvider = new ethers.providers.JsonRpcProvider(provider.rpc);

        // NFT contract address
        const nftAddress = '0x...'; // Replace with your NFT contract

        // ERC721 ABI (balanceOf only)
        const nftAbi = [
            'function balanceOf(address owner) view returns (uint256)'
        ];

        const nftContract = new ethers.Contract(nftAddress, nftAbi, ethersProvider);
        const balance = await nftContract.balanceOf(userAddress);

        if (balance.gt(0)) {
            // User owns at least one NFT - grant write access
            return { allowed: true, level: 2 };
        }

        return { allowed: false, level: 0 };
    } catch (error) {
        console.error('[checkNFTOwnership] Error:', error);
        return { allowed: false, level: 0 };
    }
}

/**
 * Example: Time-based access (only allow access during certain hours)
 */
export async function checkTimeBasedAccess(userAddress, domain, cfg) {
    const now = new Date();
    const hour = now.getUTCHours();

    // Only allow access between 9 AM and 5 PM UTC
    if (hour >= 9 && hour < 17) {
        return { allowed: true, level: 1 };
    }

    return { allowed: false, level: 0 };
}

/**
 * Example: Rate-limited access (simple in-memory implementation)
 * For production, use Redis or database
 */
const accessLog = new Map();

export async function checkRateLimitedAccess(userAddress, domain, cfg) {
    const key = `${domain}:${userAddress}`;
    const now = Date.now();
    const windowMs = 60000; // 1 minute
    const maxRequests = 100;

    const record = accessLog.get(key) || { count: 0, windowStart: now };

    if (now - record.windowStart > windowMs) {
        // New window
        accessLog.set(key, { count: 1, windowStart: now });
        return { allowed: true, level: 1 };
    }

    if (record.count >= maxRequests) {
        // Rate limit exceeded
        return { allowed: false, level: 0 };
    }

    // Increment and allow
    record.count++;
    accessLog.set(key, record);
    return { allowed: true, level: 1 };
}

/**
 * Example: Allowlist from external API
 */
export async function checkExternalAllowlist(userAddress, domain, cfg) {
    try {
        // Example: fetch from your API
        const response = await fetch(`https://api.example.com/allowlist/${userAddress}`);
        const data = await response.json();

        if (data.allowed) {
            return { allowed: true, level: data.level || 1 };
        }

        return { allowed: false, level: 0 };
    } catch (error) {
        console.error('[checkExternalAllowlist] Error:', error);
        return { allowed: false, level: 0 };
    }
}

/**
 * Example: Multi-factor check (combine multiple conditions)
 */
export async function checkMultiFactor(userAddress, domain, cfg) {
    // Check both token balance AND NFT ownership
    const tokenResult = await checkTokenBalance(userAddress, domain, cfg);
    const nftResult = await checkNFTOwnership(userAddress, domain, cfg);

    // Grant access only if user passes both checks
    if (tokenResult.allowed && nftResult.allowed) {
        // Give higher access level
        return { allowed: true, level: 2 };
    }

    return { allowed: false, level: 0 };
}
