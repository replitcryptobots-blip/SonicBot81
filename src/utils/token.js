// ════════════════════════════════════════════════════════════
// Token Utilities
// Fetch and cache token metadata (decimals, symbols, etc.)
// ════════════════════════════════════════════════════════════

import { Contract } from 'ethers';
import { logger } from '../logger.js';

// ERC20 ABI (minimal)
const ERC20_ABI = [
  'function decimals() external view returns (uint8)',
  'function symbol() external view returns (string)',
  'function name() external view returns (string)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
];

/**
 * Token metadata cache
 */
const tokenCache = new Map();

/**
 * Get token decimals (with caching)
 */
export async function getTokenDecimals(provider, tokenAddress) {
  const key = `decimals_${tokenAddress.toLowerCase()}`;

  if (tokenCache.has(key)) {
    return tokenCache.get(key);
  }

  try {
    const token = new Contract(tokenAddress, ERC20_ABI, provider.getProvider());
    const decimals = await token.decimals();

    tokenCache.set(key, decimals);
    logger.debug({ tokenAddress, decimals }, 'Token decimals fetched');

    return decimals;
  } catch (err) {
    logger.warn({ err, tokenAddress }, 'Failed to fetch token decimals, defaulting to 18');
    return 18; // Safe default
  }
}

/**
 * Get token symbol (with caching)
 */
export async function getTokenSymbol(provider, tokenAddress) {
  const key = `symbol_${tokenAddress.toLowerCase()}`;

  if (tokenCache.has(key)) {
    return tokenCache.get(key);
  }

  try {
    const token = new Contract(tokenAddress, ERC20_ABI, provider.getProvider());
    const symbol = await token.symbol();

    tokenCache.set(key, symbol);
    return symbol;
  } catch (err) {
    logger.warn({ err, tokenAddress }, 'Failed to fetch token symbol');
    return '???';
  }
}

/**
 * Get token metadata (decimals + symbol)
 */
export async function getTokenMetadata(provider, tokenAddress) {
  const [decimals, symbol] = await Promise.all([
    getTokenDecimals(provider, tokenAddress),
    getTokenSymbol(provider, tokenAddress),
  ]);

  return { decimals, symbol, address: tokenAddress };
}

/**
 * Get token balance
 */
export async function getTokenBalance(provider, tokenAddress, accountAddress) {
  try {
    const token = new Contract(tokenAddress, ERC20_ABI, provider.getProvider());
    return await token.balanceOf(accountAddress);
  } catch (err) {
    logger.error({ err, tokenAddress, accountAddress }, 'Failed to fetch token balance');
    throw err;
  }
}

/**
 * Check token allowance
 */
export async function getTokenAllowance(provider, tokenAddress, ownerAddress, spenderAddress) {
  try {
    const token = new Contract(tokenAddress, ERC20_ABI, provider.getProvider());
    return await token.allowance(ownerAddress, spenderAddress);
  } catch (err) {
    logger.error({ err, tokenAddress, ownerAddress, spenderAddress }, 'Failed to fetch allowance');
    throw err;
  }
}

/**
 * Approve token spending
 */
export async function approveToken(wallet, tokenAddress, spenderAddress, amount) {
  try {
    const token = new Contract(tokenAddress, ERC20_ABI, wallet);
    const tx = await token.approve(spenderAddress, amount);
    logger.info({ tokenAddress, spenderAddress, txHash: tx.hash }, 'Approval transaction sent');
    const receipt = await tx.wait();
    return receipt;
  } catch (err) {
    logger.error({ err, tokenAddress, spenderAddress }, 'Approval failed');
    throw err;
  }
}

/**
 * Clear cache (useful for testing)
 */
export function clearTokenCache() {
  tokenCache.clear();
  logger.debug('Token cache cleared');
}

export default {
  getTokenDecimals,
  getTokenSymbol,
  getTokenMetadata,
  getTokenBalance,
  getTokenAllowance,
  approveToken,
  clearTokenCache,
  ERC20_ABI,
};
