// ════════════════════════════════════════════════════════════
// Scanner Module
// Monitors blocks and generates arbitrage candidates
// ════════════════════════════════════════════════════════════

import { EventEmitter } from 'events';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { generatePairs, getDefaultTradeSizes } from './pairs.js';

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

    logger.info({ pairs: this.pairs.length }, 'Arbitrage scanner initialized');
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

    // Scan for arbitrage opportunities
    await this.scanForArbitrage(blockNumber);
  }

  /**
   * Scan for arbitrage opportunities
   */
  async scanForArbitrage(blockNumber) {
    if (this.pairs.length === 0) {
      logger.debug('No pairs to scan');
      return;
    }

    // Limit concurrent scans for Termux
    const maxConcurrent = config.performance.maxConcurrentRequests;

    for (let i = 0; i < this.pairs.length; i += maxConcurrent) {
      const batch = this.pairs.slice(i, i + maxConcurrent);

      const scanPromises = batch.map(pair =>
        this.scanPair(pair, blockNumber).catch(err => {
          logger.debug({ err, pair }, 'Pair scan failed');
          return null;
        })
      );

      const results = await Promise.all(scanPromises);

      // Emit opportunities
      for (const opportunity of results) {
        if (opportunity) {
          this.emit('opportunity', opportunity);
        }
      }
    }
  }

  /**
   * Scan a single pair across DEXes
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
      if (tradeSize > pair.maxTradeSize || tradeSize < pair.minTradeSize) {
        continue;
      }

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
                quote1: quote1_AB,
                quote2: quote2_BA,
              };
            }
          }
        } catch (err) {
          logger.debug({ err }, 'Route 1 (forward) quote failed');
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
                quote1: quote1_AB,
                quote2: quote2_BA,
              };
            }
          }
        } catch (err) {
          logger.debug({ err }, 'Route 2 (reverse) quote failed');
        }

      } catch (err) {
        logger.debug({ err, pair, tradeSize: tradeSize.toString() }, 'Trade size scan failed');
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
    };
  }
}

export default ArbScanner;
