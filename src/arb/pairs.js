// ════════════════════════════════════════════════════════════
// Pairs Module
// Manages token pair watchlist for arbitrage scanning
// ════════════════════════════════════════════════════════════

import { config } from '../config.js';
import { logger } from '../logger.js';
import { parseAmount } from '../math.js';

/**
 * Generate token pairs from watchlist
 */
export function generatePairs() {
  const tokens = config.watchTokens;
  const baseToken = config.baseToken;

  if (tokens.length === 0) {
    logger.warn('No tokens in watchlist - arbitrage scanning disabled');
    return [];
  }

  const pairs = [];

  // If base token is set, create pairs with base token
  if (baseToken) {
    for (const token of tokens) {
      if (token.toLowerCase() !== baseToken.toLowerCase()) {
        pairs.push({
          tokenA: baseToken,
          tokenB: token,
          // Default trade sizes - can be customized per pair
          minTradeSize: parseAmount('0.01', 18), // 0.01 tokens
          maxTradeSize: parseAmount(config.profit.maxTradeSize, 18),
        });
      }
    }
  }

  // Also create pairs between watch tokens (optional)
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      pairs.push({
        tokenA: tokens[i],
        tokenB: tokens[j],
        minTradeSize: parseAmount('0.01', 18),
        maxTradeSize: parseAmount(config.profit.maxTradeSize, 18),
      });
    }
  }

  logger.info({ count: pairs.length }, 'Token pairs generated');
  return pairs;
}

/**
 * Get default trade sizes for testing
 */
export function getDefaultTradeSizes() {
  return [
    parseAmount('0.1', 18),   // 0.1 tokens
    parseAmount('0.5', 18),   // 0.5 tokens
    parseAmount('1', 18),     // 1 token
    parseAmount('5', 18),     // 5 tokens
  ];
}

/**
 * Validate pair configuration
 */
export function validatePair(pair) {
  if (!pair.tokenA || !pair.tokenB) {
    throw new Error('Pair must have tokenA and tokenB');
  }

  if (pair.tokenA.toLowerCase() === pair.tokenB.toLowerCase()) {
    throw new Error('Pair tokens must be different');
  }

  return true;
}

export default {
  generatePairs,
  getDefaultTradeSizes,
  validatePair,
};
