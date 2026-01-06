// ════════════════════════════════════════════════════════════
// DEX Registry
// Manages all DEX adapters with multi-type support
// Supports: UniswapV2, UniswapV3, UniversalRouter
// ════════════════════════════════════════════════════════════

import { config, hasDexesConfigured } from '../config.js';
import { logger } from '../logger.js';
import { createAdapter, AdapterTypes } from './adapters/index.js';

// Legacy adapters for backward compatibility
import { Dex1Adapter } from './dex1.js';
import { Dex2Adapter } from './dex2.js';

export class DexRegistry {
  constructor(provider) {
    this.provider = provider;
    this.dexes = new Map();
    this.quoteableDexes = new Map(); // DEXes with quote support
    this.verificationStatus = new Map();

    // Initialize adapters
    this._initializeAdapters();

    logger.info({
      totalDexes: this.dexes.size,
      quoteableDexes: this.quoteableDexes.size,
      dexNames: Array.from(this.dexes.keys()),
    }, 'DEX registry initialized');
  }

  /**
   * Initialize all DEX adapters from config
   */
  _initializeAdapters() {
    // Check for new-style dynamic configuration
    if (hasDexesConfigured()) {
      this._initializeDynamicAdapters();
    } else {
      // Fall back to legacy configuration
      this._initializeLegacyAdapters();
    }
  }

  /**
   * Initialize adapters from dynamic config (DEXES env var)
   */
  _initializeDynamicAdapters() {
    for (const [dexKey, dexConfig] of Object.entries(config.dexes)) {
      try {
        const adapter = createAdapter(
          dexConfig.name,
          dexConfig.type,
          dexConfig,
          this.provider
        );

        this.dexes.set(dexKey, adapter);

        // Track quote-capable DEXes
        if (adapter.quoteSupported) {
          this.quoteableDexes.set(dexKey, adapter);
        } else {
          logger.warn({
            dex: dexKey,
            type: dexConfig.type,
          }, 'DEX initialized without quote support - will be excluded from scanning');
        }

        logger.debug({
          name: dexConfig.name,
          type: dexConfig.type,
          router: dexConfig.router,
          quoteSupported: adapter.quoteSupported,
        }, 'DEX adapter created');

      } catch (err) {
        logger.error({ err, dexKey }, 'Failed to create DEX adapter');
      }
    }
  }

  /**
   * Initialize legacy adapters (DEX1, DEX2 config)
   */
  _initializeLegacyAdapters() {
    // Initialize DEX1 if configured
    if (config.dex1.router) {
      try {
        this.dex1 = new Dex1Adapter(this.provider);
        this.dexes.set('dex1', this.dex1);
        this.quoteableDexes.set('dex1', this.dex1);
      } catch (err) {
        logger.warn({ err }, 'Failed to initialize DEX1');
      }
    }

    // Initialize DEX2 if configured
    if (config.dex2.router) {
      try {
        this.dex2 = new Dex2Adapter(this.provider);
        this.dexes.set('dex2', this.dex2);
        this.quoteableDexes.set('dex2', this.dex2);
      } catch (err) {
        logger.warn({ err }, 'Failed to initialize DEX2');
      }
    }
  }

  /**
   * Get DEX adapter by name
   * @param {string} name - DEX name or key
   * @returns {object} DEX adapter
   */
  getDex(name) {
    const key = name.toLowerCase();
    const dex = this.dexes.get(key);
    if (!dex) {
      throw new Error(`DEX not found: ${name}. Available: ${Array.from(this.dexes.keys()).join(', ')}`);
    }
    return dex;
  }

  /**
   * Get all DEX adapters
   * @returns {object[]} Array of all DEX adapters
   */
  getAllDexes() {
    return Array.from(this.dexes.values());
  }

  /**
   * Get DEXes that support quoting
   * @returns {object[]} Array of quote-capable DEX adapters
   */
  getQuoteableDexes() {
    return Array.from(this.quoteableDexes.values());
  }

  /**
   * Get DEX pairs for arbitrage scanning
   * Returns pairs of DEXes that can be used for arb
   * @returns {Array<[object, object]>} Array of DEX pairs
   */
  getDexPairs() {
    const quoteableDexes = this.getQuoteableDexes();
    const pairs = [];

    // Generate all pairs (order matters for direction)
    for (let i = 0; i < quoteableDexes.length; i++) {
      for (let j = 0; j < quoteableDexes.length; j++) {
        if (i !== j) {
          pairs.push([quoteableDexes[i], quoteableDexes[j]]);
        }
      }
    }

    return pairs;
  }

  /**
   * Get DEXes by type
   * @param {string} type - Adapter type (uniswap_v2, uniswap_v3, universal_router)
   * @returns {object[]} Array of matching DEX adapters
   */
  getDexesByType(type) {
    return Array.from(this.dexes.values()).filter(dex => dex.type === type);
  }

  /**
   * Get quotes from all quoteable DEXes
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {bigint} amountIn - Input amount
   * @returns {Promise<Array>} Array of quotes with dex info
   */
  async getAllQuotes(tokenIn, tokenOut, amountIn) {
    const quotes = [];
    const quoteableDexes = this.getQuoteableDexes();

    for (const dex of quoteableDexes) {
      try {
        const quote = await dex.getQuote(tokenIn, tokenOut, amountIn);
        quotes.push({
          dex: dex.name,
          type: dex.type,
          ...quote,
        });
      } catch (err) {
        logger.debug({ err: err.message, dex: dex.name }, 'Quote failed');
      }
    }

    return quotes;
  }

  /**
   * Find best quote across all DEXes
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {bigint} amountIn - Input amount
   * @returns {Promise<object>} Best quote with dex info
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
   * Verify all DEX contracts exist on-chain
   * In DRY_RUN mode, logs warnings but doesn't throw
   * @returns {Promise<{passed: string[], failed: string[]}>}
   */
  async verifyAll() {
    const results = {
      passed: [],
      failed: [],
    };

    const verifications = [];

    for (const [name, dex] of this.dexes) {
      verifications.push(
        dex.verify(this.provider)
          .then(() => {
            this.verificationStatus.set(name, 'verified');
            results.passed.push(name);
            return { name, success: true };
          })
          .catch(err => {
            this.verificationStatus.set(name, 'failed');
            results.failed.push(name);

            if (config.dryRun) {
              logger.warn({ err: err.message, dex: name }, 'DEX verification failed (DRY_RUN mode - continuing)');
            } else {
              logger.error({ err: err.message, dex: name }, 'DEX verification failed');
            }

            return { name, success: false, error: err.message };
          })
      );
    }

    await Promise.all(verifications);

    if (results.passed.length > 0) {
      logger.info({ dexes: results.passed }, 'DEX verifications passed');
    }

    if (results.failed.length > 0 && !config.dryRun) {
      throw new Error(`DEX verification failed for: ${results.failed.join(', ')}`);
    }

    return results;
  }

  /**
   * Verify contracts on-chain by getting code
   * Updates quote support status based on verification
   * @param {object} provider - RPC provider for getCode calls
   * @returns {Promise<boolean>}
   */
  async verifyContractsOnChain(provider) {
    const checks = [];

    for (const [name, dex] of this.dexes) {
      // Verify router
      if (dex.routerAddress) {
        checks.push(
          provider.getCode(dex.routerAddress)
            .then(code => {
              if (!code || code === '0x') {
                throw new Error(`${name} router has no code at ${dex.routerAddress}`);
              }
              logger.debug({ dex: name, router: dex.routerAddress }, 'Router verified');
            })
            .catch(err => {
              logger.warn({ dex: name, err: err.message }, 'Router verification failed');
              // Remove from quoteable if can't verify
              this.quoteableDexes.delete(name);
              throw err;
            })
        );
      }

      // Verify quoter (for V3 and UniversalRouter)
      if (dex.quoterAddress) {
        checks.push(
          provider.getCode(dex.quoterAddress)
            .then(code => {
              if (!code || code === '0x') {
                logger.warn({ dex: name }, 'Quoter has no code - disabling quote support');
                dex.quoteSupported = false;
                this.quoteableDexes.delete(name);
              } else {
                logger.debug({ dex: name, quoter: dex.quoterAddress }, 'Quoter verified');
              }
            })
            .catch(err => {
              logger.warn({ dex: name, err: err.message }, 'Quoter verification failed');
              dex.quoteSupported = false;
              this.quoteableDexes.delete(name);
            })
        );
      }
    }

    try {
      await Promise.all(checks);
      return true;
    } catch (err) {
      return false;
    }
  }

  /**
   * Get registry stats for display
   * @returns {object} Stats object
   */
  getStats() {
    const typeCount = {};
    for (const dex of this.dexes.values()) {
      typeCount[dex.type] = (typeCount[dex.type] || 0) + 1;
    }

    return {
      totalDexes: this.dexes.size,
      quoteableDexes: this.quoteableDexes.size,
      dexNames: Array.from(this.dexes.keys()),
      dexTypes: typeCount,
      verificationStatus: Object.fromEntries(this.verificationStatus),
    };
  }

  /**
   * Get detailed info for all DEXes
   * @returns {object[]} Array of DEX info objects
   */
  getAllDexInfo() {
    return Array.from(this.dexes.values()).map(dex => dex.getInfo());
  }

  /**
   * Check if a DEX is quoteable
   * @param {string} name - DEX name or key
   * @returns {boolean}
   */
  isQuoteable(name) {
    return this.quoteableDexes.has(name.toLowerCase());
  }

  /**
   * Get count of configured DEXes
   * @returns {number}
   */
  getDexCount() {
    return this.dexes.size;
  }

  /**
   * Check if any DEXes are configured
   * @returns {boolean}
   */
  hasDexes() {
    return this.dexes.size > 0;
  }
}

export default DexRegistry;
