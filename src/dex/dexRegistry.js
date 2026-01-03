// ════════════════════════════════════════════════════════════
// DEX Registry
// Manages all DEX adapters and provides unified interface
// ════════════════════════════════════════════════════════════

import { Dex1Adapter } from './dex1.js';
import { Dex2Adapter } from './dex2.js';
import { logger } from '../logger.js';

export class DexRegistry {
  constructor(provider) {
    this.provider = provider;
    this.dexes = new Map();

    // Initialize adapters
    this.dex1 = new Dex1Adapter(provider);
    this.dex2 = new Dex2Adapter(provider);

    this.dexes.set('dex1', this.dex1);
    this.dexes.set('dex2', this.dex2);

    logger.info({ count: this.dexes.size }, 'DEX registry initialized');
  }

  /**
   * Get DEX adapter by name
   */
  getDex(name) {
    const dex = this.dexes.get(name.toLowerCase());
    if (!dex) {
      throw new Error(`DEX not found: ${name}`);
    }
    return dex;
  }

  /**
   * Get all DEX adapters
   */
  getAllDexes() {
    return Array.from(this.dexes.values());
  }

  /**
   * Get quotes from all DEXes
   */
  async getAllQuotes(tokenIn, tokenOut, amountIn) {
    const quotes = [];

    for (const [name, dex] of this.dexes) {
      try {
        const quote = await dex.getQuote(tokenIn, tokenOut, amountIn);
        quotes.push({
          dex: name,
          ...quote,
        });
      } catch (err) {
        logger.debug({ err, dex: name }, 'Quote failed');
      }
    }

    return quotes;
  }

  /**
   * Find best quote across all DEXes
   */
  async getBestQuote(tokenIn, tokenOut, amountIn) {
    const quotes = await this.getAllQuotes(tokenIn, tokenOut, amountIn);

    if (quotes.length === 0) {
      throw new Error('No quotes available');
    }

    // Sort by amountOut descending
    quotes.sort((a, b) => {
      if (a.amountOut > b.amountOut) return -1;
      if (a.amountOut < b.amountOut) return 1;
      return 0;
    });

    return quotes[0];
  }

  /**
   * Verify all DEX contracts
   */
  async verifyAll() {
    const checks = [];

    for (const [name, dex] of this.dexes) {
      if (dex.routerAddress || dex.factoryAddress) {
        checks.push(
          dex.verify(this.provider).catch(err => {
            logger.warn({ err, dex: name }, 'DEX verification failed');
            throw err;
          })
        );
      }
    }

    if (checks.length > 0) {
      await Promise.all(checks);
      logger.info('All DEX verifications passed');
    } else {
      logger.warn('No DEX contracts configured to verify');
    }
  }
}

export default DexRegistry;
