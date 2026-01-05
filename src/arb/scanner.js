// ════════════════════════════════════════════════════════════
// Scanner Module
// Monitors blocks and generates arbitrage candidates
// Supports cross-type routing: V2<->V3, UniversalRouter<->V2, etc.
// ════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { generatePairs, getDefaultTradeSizes } from './pairs.js';

/**
 * Route cooldown tracker for failed routes
 * Prevents hammering broken pools/routes
 */
class RouteCooldown {
  constructor(cooldownMs) {
    this.cooldownMs = cooldownMs;
    this.cooldowns = new Map(); // routeKey -> cooldownUntil
  }

  /**
   * Generate unique key for a route
   */
  getRouteKey(dex1Name, dex2Name, tokenA, tokenB) {
    return `${dex1Name}:${dex2Name}:${tokenA}:${tokenB}`.toLowerCase();
  }

  /**
   * Mark a route as failed (start cooldown)
   */
  markFailed(dex1Name, dex2Name, tokenA, tokenB) {
    const key = this.getRouteKey(dex1Name, dex2Name, tokenA, tokenB);
    this.cooldowns.set(key, Date.now() + this.cooldownMs);
    logger.debug({ route: key, cooldownMs: this.cooldownMs }, 'Route marked for cooldown');
  }

  /**
   * Check if a route is in cooldown
   */
  isInCooldown(dex1Name, dex2Name, tokenA, tokenB) {
    const key = this.getRouteKey(dex1Name, dex2Name, tokenA, tokenB);
    const cooldownUntil = this.cooldowns.get(key);
    if (!cooldownUntil) return false;

    if (Date.now() >= cooldownUntil) {
      this.cooldowns.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Clean up expired cooldowns
   */
  cleanup() {
    const now = Date.now();
    for (const [key, until] of this.cooldowns) {
      if (now >= until) {
        this.cooldowns.delete(key);
      }
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      activeCooldowns: this.cooldowns.size,
      cooldownMs: this.cooldownMs,
    };
  }
}

export class ArbScanner extends EventEmitter {
  constructor(provider, dexRegistry) {
    super();
    this.provider = provider;
    this.dexRegistry = dexRegistry;
    this.pairs = generatePairs();
    this.tradeSizes = getDefaultTradeSizes();
    this.isRunning = false;
    this.lastBlock = 0;
    this.scanCount = 0;
    this.opportunitiesFound = 0;

    // Route cooldown for error handling
    this.routeCooldown = new RouteCooldown(
      config.routing?.routeErrorCooldown || 30000
    );

    // Scan statistics
    this.scanStats = {
      totalScans: 0,
      successfulQuotes: 0,
      failedQuotes: 0,
      routesInCooldown: 0,
    };

    logger.info({
      pairs: this.pairs.length,
      tradeSizes: this.tradeSizes.map(s => s.toString()),
      dexCount: dexRegistry.getDexCount ? dexRegistry.getDexCount() : dexRegistry.getAllDexes().length,
      quoteableDexes: dexRegistry.getQuoteableDexes ? dexRegistry.getQuoteableDexes().length : dexRegistry.getAllDexes().length,
    }, 'Arbitrage scanner initialized');
  }

  /**
   * Start scanning
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Scanner already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting arbitrage scanner...');

    // Try WebSocket first, fall back to polling
    const wsProvider = this.provider.getWsProvider();

    if (wsProvider) {
      await this.startWebSocketMonitoring(wsProvider);
    } else {
      await this.startPollingMonitoring();
    }
  }

  /**
   * Stop scanning
   */
  async stop() {
    this.isRunning = false;
    logger.info('Stopping arbitrage scanner...');

    // Remove event listeners
    const wsProvider = this.provider.getWsProvider();
    if (wsProvider) {
      wsProvider.removeAllListeners('block');
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * WebSocket-based block monitoring
   */
  async startWebSocketMonitoring(wsProvider) {
    logger.info('Using WebSocket for block monitoring');

    wsProvider.on('block', async (blockNumber) => {
      if (!this.isRunning) return;

      try {
        await this.onNewBlock(blockNumber);
      } catch (err) {
        logger.error({ err, blockNumber }, 'Block processing error');
      }
    });

    // Initial block
    const currentBlock = await this.provider.getBlockNumber();
    await this.onNewBlock(currentBlock);
  }

  /**
   * Polling-based block monitoring
   */
  async startPollingMonitoring() {
    logger.info({
      intervalMs: config.performance.blockPollInterval
    }, 'Using polling for block monitoring');

    this.pollInterval = setInterval(async () => {
      if (!this.isRunning) return;

      try {
        const blockNumber = await this.provider.getBlockNumber();

        if (blockNumber > this.lastBlock) {
          await this.onNewBlock(blockNumber);
        }
      } catch (err) {
        logger.error({ err }, 'Block polling error');
      }
    }, config.performance.blockPollInterval);

    // Initial scan
    const currentBlock = await this.provider.getBlockNumber();
    await this.onNewBlock(currentBlock);
  }

  /**
   * Process new block
   */
  async onNewBlock(blockNumber) {
    if (blockNumber <= this.lastBlock) return;

    this.lastBlock = blockNumber;
    this.scanCount++;

    logger.debug({ blockNumber, scanCount: this.scanCount }, 'New block');

    // Clean up expired cooldowns periodically
    if (this.scanCount % 10 === 0) {
      this.routeCooldown.cleanup();
    }

    // Scan for arbitrage opportunities
    await this.scanForArbitrage(blockNumber);
  }

  /**
   * Scan for arbitrage opportunities across all DEX pairs
   */
  async scanForArbitrage(blockNumber) {
    if (this.pairs.length === 0) {
      logger.debug('No pairs to scan');
      return;
    }

    // Get quoteable DEXes (or all DEXes for legacy compatibility)
    const quoteableDexes = this.dexRegistry.getQuoteableDexes
      ? this.dexRegistry.getQuoteableDexes()
      : this.dexRegistry.getAllDexes();

    if (quoteableDexes.length < 2) {
      logger.debug('Need at least 2 quoteable DEXes for arbitrage');
      return;
    }

    // Limit concurrent scans for Termux
    const maxConcurrent = config.performance.maxConcurrentRequests;

    for (let i = 0; i < this.pairs.length; i += maxConcurrent) {
      const batch = this.pairs.slice(i, i + maxConcurrent);

      const scanPromises = batch.map(pair =>
        this.scanPairAcrossAllDexes(pair, blockNumber, quoteableDexes).catch(err => {
          logger.debug({ err: err.message, pair }, 'Pair scan failed');
          return [];
        })
      );

      const results = await Promise.all(scanPromises);

      // Emit opportunities (results is array of arrays)
      for (const opportunities of results) {
        if (opportunities && opportunities.length > 0) {
          for (const opportunity of opportunities) {
            this.opportunitiesFound++;
            this.emit('opportunity', opportunity);
          }
        }
      }
    }

    this.scanStats.totalScans++;
  }

  /**
   * Scan a single token pair across all DEX combinations
   * @param {object} pair - Token pair
   * @param {number} blockNumber - Current block
   * @param {object[]} dexes - Array of DEX adapters
   * @returns {Promise<Array>} Array of opportunities
   */
  async scanPairAcrossAllDexes(pair, blockNumber, dexes) {
    const { tokenA, tokenB } = pair;
    const opportunities = [];

    // Generate all DEX pairs (order matters for direction)
    for (let i = 0; i < dexes.length; i++) {
      for (let j = 0; j < dexes.length; j++) {
        if (i === j) continue;

        const dex1 = dexes[i];
        const dex2 = dexes[j];

        // Skip if this route is in cooldown
        if (this.routeCooldown.isInCooldown(dex1.name, dex2.name, tokenA, tokenB)) {
          this.scanStats.routesInCooldown++;
          continue;
        }

        // Try different trade sizes
        for (const tradeSize of this.tradeSizes) {
          // Skip if trade size exceeds limits
          if (pair.maxTradeSize && tradeSize > pair.maxTradeSize) continue;
          if (pair.minTradeSize && tradeSize < pair.minTradeSize) continue;

          try {
            const opportunity = await this.scanRoute(
              dex1,
              dex2,
              tokenA,
              tokenB,
              tradeSize,
              blockNumber
            );

            if (opportunity) {
              opportunities.push(opportunity);
              // Found opportunity at this size, no need to try larger sizes for this route
              break;
            }
          } catch (err) {
            this.handleRouteError(err, dex1.name, dex2.name, tokenA, tokenB);
          }
        }
      }
    }

    return opportunities;
  }

  /**
   * Scan a specific route: DEX1 -> DEX2 for a token pair
   * @param {object} dex1 - First DEX adapter
   * @param {object} dex2 - Second DEX adapter
   * @param {string} tokenA - First token
   * @param {string} tokenB - Second token
   * @param {bigint} tradeSize - Trade amount
   * @param {number} blockNumber - Current block
   * @returns {Promise<object|null>} Opportunity or null
   */
  async scanRoute(dex1, dex2, tokenA, tokenB, tradeSize, blockNumber) {
    try {
      // Step 1: Get quote for A -> B on DEX1
      const quote1 = await dex1.getQuote(tokenA, tokenB, tradeSize);
      this.scanStats.successfulQuotes++;

      if (!quote1 || quote1.amountOut <= 0n) {
        return null;
      }

      // Step 2: CRITICAL - Use output from step 1 as input for step 2
      const quote2 = await dex2.getQuote(tokenB, tokenA, quote1.amountOut);
      this.scanStats.successfulQuotes++;

      if (!quote2 || quote2.amountOut <= 0n) {
        return null;
      }

      // Step 3: Check if profitable (output > input)
      if (quote2.amountOut > tradeSize) {
        const rawProfit = quote2.amountOut - tradeSize;

        logger.debug({
          route: `${dex1.name} -> ${dex2.name}`,
          tokenA,
          tokenB,
          amountIn: tradeSize.toString(),
          amountOut: quote2.amountOut.toString(),
          rawProfit: rawProfit.toString(),
          dex1Type: dex1.type,
          dex2Type: dex2.type,
        }, 'Potential arbitrage found');

        return {
          blockNumber,
          timestamp: Date.now(),
          route: `${dex1.name}->${dex2.name}`,
          tokenA,
          tokenB,
          amountIn: tradeSize,
          dex1: dex1.name,
          dex2: dex2.name,
          dex1Type: dex1.type || 'uniswap_v2',
          dex2Type: dex2.type || 'uniswap_v2',
          quote1: {
            amountOut: quote1.amountOut,
            path: quote1.path,
            dex: quote1.dex || dex1.name,
            type: quote1.type || dex1.type || 'uniswap_v2',
            feeTier: quote1.feeTier || null,
          },
          quote2: {
            amountOut: quote2.amountOut,
            path: quote2.path,
            dex: quote2.dex || dex2.name,
            type: quote2.type || dex2.type || 'uniswap_v2',
            feeTier: quote2.feeTier || null,
          },
          rawProfit,
          isCrossType: (dex1.type || 'v2') !== (dex2.type || 'v2'),
        };
      }

      return null;

    } catch (err) {
      this.scanStats.failedQuotes++;
      throw err;
    }
  }

  /**
   * Handle route errors with appropriate cooldowns
   */
  handleRouteError(err, dex1Name, dex2Name, tokenA, tokenB) {
    const msg = err.message || '';

    // Classify error types for appropriate handling
    const isBadData = msg.includes('BAD_DATA') ||
                       msg.includes('require(false)') ||
                       msg.includes('execution reverted');

    const isNoLiquidity = msg.includes('INSUFFICIENT_LIQUIDITY') ||
                          msg.includes('No liquidity') ||
                          msg.includes('insufficient liquidity');

    const isInvalidPath = msg.includes('INVALID_PATH') ||
                          msg.includes('No pool') ||
                          msg.includes('pool not found');

    const isRateLimit = msg.includes('429') ||
                        msg.includes('rate limit') ||
                        msg.includes('too many requests');

    if (isNoLiquidity || isInvalidPath) {
      // These are expected for non-existent pairs, longer cooldown
      this.routeCooldown.markFailed(dex1Name, dex2Name, tokenA, tokenB);
      logger.debug({ route: `${dex1Name}->${dex2Name}`, tokenA, tokenB }, 'Route has no liquidity - cooled down');
    } else if (isBadData) {
      // Contract issues, cooldown
      this.routeCooldown.markFailed(dex1Name, dex2Name, tokenA, tokenB);
      logger.debug({ route: `${dex1Name}->${dex2Name}`, error: msg.slice(0, 100) }, 'Route contract error - cooled down');
    } else if (isRateLimit) {
      // Rate limited, log but don't cooldown the route specifically
      logger.warn('Rate limited - will slow down');
    } else {
      // Other errors - log at debug level
      logger.debug({
        route: `${dex1Name}->${dex2Name}`,
        tokenA,
        tokenB,
        error: msg.slice(0, 100),
      }, 'Route quote failed');
    }
  }

  /**
   * Legacy method for backward compatibility
   * Scans a single pair across DEXes using the old approach
   */
  async scanPair(pair, blockNumber) {
    const { tokenA, tokenB } = pair;
    const dexes = this.dexRegistry.getAllDexes();

    if (dexes.length < 2) {
      logger.debug('Need at least 2 DEXes for arbitrage');
      return null;
    }

    // Try different trade sizes
    for (const tradeSize of this.tradeSizes) {
      // Skip if trade size exceeds limits
      if (pair.maxTradeSize && tradeSize > pair.maxTradeSize) continue;
      if (pair.minTradeSize && tradeSize < pair.minTradeSize) continue;

      try {
        // ROUTE 1: A -> B on DEX1, B -> A on DEX2
        // CRITICAL: Second leg must use output from first leg!
        try {
          const quote1_AB = await dexes[0].getQuote(tokenA, tokenB, tradeSize);

          if (quote1_AB && quote1_AB.amountOut > 0n) {
            // Second leg: Use output from first leg as input
            const quote2_BA = await dexes[1].getQuote(tokenB, tokenA, quote1_AB.amountOut);

            if (quote2_BA && quote2_BA.amountOut > tradeSize) {
              // Potential profit!
              return {
                blockNumber,
                timestamp: Date.now(),
                route: 'forward',
                tokenA,
                tokenB,
                amountIn: tradeSize,
                dex1: dexes[0].name,
                dex2: dexes[1].name,
                dex1Type: dexes[0].type || 'uniswap_v2',
                dex2Type: dexes[1].type || 'uniswap_v2',
                quote1: quote1_AB,
                quote2: quote2_BA,
              };
            }
          }
        } catch (err) {
          logger.debug({ err: err.message }, 'Route 1 (forward) quote failed');
        }

        // ROUTE 2: A -> B on DEX2, B -> A on DEX1
        try {
          const quote1_AB = await dexes[1].getQuote(tokenA, tokenB, tradeSize);

          if (quote1_AB && quote1_AB.amountOut > 0n) {
            // Second leg: Use output from first leg as input
            const quote2_BA = await dexes[0].getQuote(tokenB, tokenA, quote1_AB.amountOut);

            if (quote2_BA && quote2_BA.amountOut > tradeSize) {
              // Potential profit!
              return {
                blockNumber,
                timestamp: Date.now(),
                route: 'reverse',
                tokenA,
                tokenB,
                amountIn: tradeSize,
                dex1: dexes[1].name,
                dex2: dexes[0].name,
                dex1Type: dexes[1].type || 'uniswap_v2',
                dex2Type: dexes[0].type || 'uniswap_v2',
                quote1: quote1_AB,
                quote2: quote2_BA,
              };
            }
          }
        } catch (err) {
          logger.debug({ err: err.message }, 'Route 2 (reverse) quote failed');
        }

      } catch (err) {
        logger.debug({ err: err.message, pair, tradeSize: tradeSize.toString() }, 'Trade size scan failed');
      }
    }

    return null;
  }

  /**
   * Get scanner stats
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      lastBlock: this.lastBlock,
      scanCount: this.scanCount,
      pairCount: this.pairs.length,
      opportunitiesFound: this.opportunitiesFound,
      quoteableDexes: this.dexRegistry.getQuoteableDexes
        ? this.dexRegistry.getQuoteableDexes().length
        : this.dexRegistry.getAllDexes().length,
      ...this.scanStats,
      cooldownStats: this.routeCooldown.getStats(),
    };
  }
}

export default ArbScanner;
