#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// SONIC MEV ARBITRAGE BOT
// Production-grade flashloan arbitrage for Termux on Android
// ════════════════════════════════════════════════════════════

import { writeFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { config, getSanitizedConfig } from './config.js';
import { logger, flushLogs } from './logger.js';
import { createProvider, createWallet } from './provider.js';
import { runAllValidations } from './validate.js';
import { DexRegistry } from './dex/dexRegistry.js';
import { ArbScanner } from './arb/scanner.js';
import { ArbSimulator } from './arb/simulator.js';
import { createFlashloanProvider } from './exec/flashloan.js';
import { ArbExecutor } from './exec/executor.js';

/**
 * Global state
 */
let state = {
  lastBlock: 0,
  opportunitiesFound: 0,
  opportunitiesAccepted: 0,
  opportunitiesExecuted: 0,
  startTime: Date.now(),
};

/**
 * Load persisted state
 */
async function loadState() {
  try {
    if (existsSync(config.logging.stateFile)) {
      const data = await readFile(config.logging.stateFile, 'utf8');
      const loaded = JSON.parse(data);
      state = { ...state, ...loaded };
      logger.info({ state }, 'State loaded');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to load state, using defaults');
  }
}

/**
 * Save state to disk
 */
async function saveState() {
  try {
    await writeFile(
      config.logging.stateFile,
      JSON.stringify(state, null, 2),
      'utf8'
    );
    logger.debug('State saved');
  } catch (err) {
    logger.error({ err }, 'Failed to save state');
  }
}

/**
 * Display banner
 */
function displayBanner() {
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log('  SONIC MEV ARBITRAGE BOT');
  console.log('  Production-Grade Flashloan Arbitrage');
  console.log('  Optimized for Termux on Android');
  console.log('════════════════════════════════════════════════════════════');
  console.log('');
}

/**
 * Display configuration summary
 */
function displayConfig() {
  const sanitized = getSanitizedConfig();

  logger.info('Configuration:');
  logger.info(`  Chain ID: ${sanitized.chainId} (Sonic)`);
  logger.info(`  RPC URLs: ${sanitized.rpcUrls.length} configured`);
  logger.info(`  Mode: ${sanitized.dryRun ? 'DRY RUN' : 'LIVE'}`);
  logger.info(`  DEX1: ${sanitized.dex1.name} (fee: ${sanitized.dex1.feeBps} bps)`);
  logger.info(`  DEX2: ${sanitized.dex2.name} (fee: ${sanitized.dex2.feeBps} bps)`);
  logger.info(`  Flashloan fee: ${sanitized.flashloan.feeBps} bps`);
  logger.info(`  Min net profit: ${sanitized.profit.minNetProfit} (${sanitized.profit.minNetProfitBps} bps)`);
  logger.info(`  Max slippage: ${sanitized.profit.maxSlippageBps} bps`);
  logger.info(`  Circuit breaker: ${sanitized.circuitBreaker.maxConsecutiveFailures} failures`);
  logger.info('');
}

/**
 * Main bot logic
 */
async function main() {
  displayBanner();

  // Load persisted state
  await loadState();

  // Create provider
  logger.info('Initializing provider...');
  const provider = await createProvider();

  // Run validations
  logger.info('Running validations...');
  await runAllValidations(provider);

  // Display config
  displayConfig();

  // Create wallet (only if private key configured)
  let wallet = null;
  if (config.privateKey) {
    wallet = createWallet(provider);
  } else {
    logger.warn('No private key configured - execution disabled');
  }

  // Initialize DEX registry
  logger.info('Initializing DEX adapters...');
  const dexRegistry = new DexRegistry(provider);

  // Verify DEX contracts (only in live mode)
  if (!config.dryRun) {
    await dexRegistry.verifyAll();
  }

  // Initialize flashloan provider
  logger.info('Initializing flashloan provider...');
  const flashloanProvider = createFlashloanProvider(provider);

  if (flashloanProvider && !config.dryRun) {
    await flashloanProvider.verify();
  }

  // Initialize simulator
  logger.info('Initializing simulator...');
  const simulator = new ArbSimulator(provider);

  // Initialize executor (only if wallet available)
  let executor = null;
  if (wallet) {
    logger.info('Initializing executor...');
    executor = new ArbExecutor(provider, wallet, dexRegistry, flashloanProvider);
  }

  // Initialize scanner
  logger.info('Initializing scanner...');
  const scanner = new ArbScanner(provider, dexRegistry);

  // Handle opportunities
  scanner.on('opportunity', async (opportunity) => {
    state.opportunitiesFound++;

    logger.debug({
      blockNumber: opportunity.blockNumber,
      route: opportunity.route,
      dex1: opportunity.dex1,
      dex2: opportunity.dex2,
    }, 'Opportunity found');

    // Simulate
    const simulation = await simulator.simulate(opportunity);

    if (simulation.decision === 'ACCEPT') {
      state.opportunitiesAccepted++;

      logger.info({
        netProfit: simulation.metrics.netProfitFormatted,
        profitPercent: simulation.metrics.profitPercent,
      }, '✓ Profitable opportunity');

      // Execute (if executor available)
      if (executor) {
        const result = await executor.execute(opportunity, simulation);

        if (result.success) {
          state.opportunitiesExecuted++;

          if (result.txHash) {
            logger.info({ txHash: result.txHash }, 'Trade executed successfully');
          }
        }
      } else {
        logger.warn('No executor available - skipping execution');
      }
    }

    // Save state periodically
    if (state.opportunitiesFound % 10 === 0) {
      state.lastBlock = opportunity.blockNumber;
      await saveState();
    }
  });

  // Start scanning
  logger.info('Starting arbitrage scanner...');
  await scanner.start();

  logger.info('═══════════════════════════════════════════════════════');
  logger.info('  Bot is running!');
  logger.info('  Press Ctrl+C to stop gracefully');
  logger.info('═══════════════════════════════════════════════════════');

  // Display stats periodically
  const statsInterval = setInterval(() => {
    const scannerStats = scanner.getStats();
    const executorStats = executor ? executor.getStats() : null;
    const uptime = Math.floor((Date.now() - state.startTime) / 1000);

    logger.info('Stats:');
    logger.info(`  Uptime: ${uptime}s`);
    logger.info(`  Last block: ${scannerStats.lastBlock}`);
    logger.info(`  Scans: ${scannerStats.scanCount}`);
    logger.info(`  Opportunities: ${state.opportunitiesFound} found, ${state.opportunitiesAccepted} profitable`);

    if (executorStats) {
      logger.info(`  Executions: ${executorStats.executionCount} (${executorStats.successRate} success)`);
      logger.info(`  Circuit breaker: ${executorStats.circuitBreaker.isOpen ? 'OPEN' : 'closed'}`);
    }

    logger.info('');
  }, 60000); // Every 60 seconds

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    clearInterval(statsInterval);

    // Stop scanner
    await scanner.stop();

    // Save final state
    state.lastBlock = scanner.lastBlock;
    await saveState();

    // Final stats
    const finalStats = {
      uptime: Math.floor((Date.now() - state.startTime) / 1000),
      opportunitiesFound: state.opportunitiesFound,
      opportunitiesAccepted: state.opportunitiesAccepted,
      opportunitiesExecuted: state.opportunitiesExecuted,
      executor: executor ? executor.getStats() : null,
    };

    logger.info({ finalStats }, 'Final statistics');

    // Flush logs
    await flushLogs();

    // Cleanup provider
    await provider.destroy();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  // Handle signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Handle uncaught errors
  process.on('unhandledRejection', (err) => {
    logger.error({ err }, 'Unhandled rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught exception');
    shutdown('UNCAUGHT_EXCEPTION');
  });
}

/**
 * Entry point with error handling
 */
(async () => {
  try {
    await main();
  } catch (err) {
    logger.error({ err }, 'Fatal error');
    await flushLogs();
    process.exit(1);
  }
})();
