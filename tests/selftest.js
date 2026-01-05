#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// Self-Test Script
// Validates bot setup and configuration without running live
// Tests multi-DEX registry, adapters, and quote functionality
// ════════════════════════════════════════════════════════════

import { config, isLiveMode, hasDexesConfigured } from '../src/config.js';
import { logger } from '../src/logger.js';
import { createProvider } from '../src/provider.js';
import { DexRegistry } from '../src/dex/dexRegistry.js';
import { ArbSimulator } from '../src/arb/simulator.js';
import { parseAmount, formatAmount } from '../src/math.js';

console.log('');
console.log('════════════════════════════════════════════════════════════');
console.log('  SONIC MEV BOT - SELF TEST');
console.log('  Multi-DEX Integration Test Suite');
console.log('════════════════════════════════════════════════════════════');
console.log('');

const tests = [];
let passCount = 0;
let failCount = 0;
let skipCount = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      console.log(`Testing: ${name}...`);
      const result = await fn();
      if (result === 'SKIP') {
        console.log(`⊘ ${name} (skipped)`);
        skipCount++;
      } else {
        console.log(`✓ ${name} passed`);
        passCount++;
      }
    } catch (err) {
      console.error(`✗ ${name} failed:`, err.message);
      failCount++;
    }
  }
}

// ════════════════════════════════════════════════════════════
// BASIC TESTS
// ════════════════════════════════════════════════════════════

test('Config loads correctly', () => {
  if (!config.chainId) throw new Error('Chain ID not loaded');
  if (config.rpcUrls.length === 0) throw new Error('No RPC URLs configured');

  console.log(`  Chain ID: ${config.chainId}`);
  console.log(`  RPC URLs: ${config.rpcUrls.length}`);
  console.log(`  DRY_RUN: ${config.dryRun}`);
  console.log(`  LIVE_MODE: ${config.liveMode}`);
  console.log(`  Effective live mode: ${isLiveMode()}`);
});

test('Safety defaults are correct', () => {
  // Verify safe defaults
  if (config.dryRun !== true && !process.env.DRY_RUN) {
    throw new Error('DRY_RUN should default to true');
  }

  if (isLiveMode() && !config.iUnderstandRisks) {
    throw new Error('LIVE mode should not be enabled without I_UNDERSTAND_RISKS');
  }

  console.log('  Safety defaults verified ✓');
});

test('Chain ID is Sonic mainnet (146)', () => {
  if (config.chainId !== 146) {
    throw new Error(`Expected chain ID 146 (Sonic), got ${config.chainId}`);
  }
  console.log('  Chain ID 146 (Sonic mainnet) ✓');
});

// ════════════════════════════════════════════════════════════
// DEX CONFIGURATION TESTS
// ════════════════════════════════════════════════════════════

test('DEX configuration parsing', () => {
  const hasDexes = hasDexesConfigured();
  console.log(`  Dynamic DEX config: ${hasDexes ? 'YES' : 'NO (using legacy)'}`);

  if (hasDexes) {
    const dexNames = Object.keys(config.dexes);
    console.log(`  Configured DEXes: ${dexNames.join(', ')}`);

    for (const [name, dexConfig] of Object.entries(config.dexes)) {
      console.log(`    - ${name}: type=${dexConfig.type}, router=${dexConfig.router ? '✓' : '✗'}`);

      if (!dexConfig.router) {
        throw new Error(`DEX ${name} has no router configured`);
      }
    }
  } else {
    // Legacy config
    console.log(`  DEX1: ${config.dex1.name} (router: ${config.dex1.router ? '✓' : '✗'})`);
    console.log(`  DEX2: ${config.dex2.name} (router: ${config.dex2.router ? '✓' : '✗'})`);
  }
});

test('V3 fee tier configuration', () => {
  console.log(`  Default V3 fee: ${config.v3?.defaultFee || 3000}`);
  console.log(`  V3 fee tiers: ${(config.v3?.feeTiers || [500, 3000, 10000]).join(', ')}`);
});

// ════════════════════════════════════════════════════════════
// RPC CONNECTIVITY TESTS
// ════════════════════════════════════════════════════════════

test('RPC connectivity', async () => {
  const provider = await createProvider();

  const blockNumber = await provider.getBlockNumber();
  if (!blockNumber) throw new Error('Failed to get block number');

  console.log(`  Current block: ${blockNumber}`);

  const chainId = await provider.getChainId();
  if (chainId !== config.chainId) {
    throw new Error(`Chain ID mismatch: expected ${config.chainId}, got ${chainId}`);
  }

  console.log(`  Chain ID verified: ${chainId} ✓`);

  await provider.destroy();
});

// ════════════════════════════════════════════════════════════
// DEX REGISTRY TESTS
// ════════════════════════════════════════════════════════════

test('DEX registry initialization', async () => {
  const provider = await createProvider();
  const dexRegistry = new DexRegistry(provider);

  const dexCount = dexRegistry.getDexCount ? dexRegistry.getDexCount() : dexRegistry.getAllDexes().length;
  console.log(`  Total DEXes registered: ${dexCount}`);

  if (dexCount === 0) {
    console.log('  Warning: No DEXes configured');
    await provider.destroy();
    return 'SKIP';
  }

  // Get all DEXes and display info
  const allDexes = dexRegistry.getAllDexes();
  for (const dex of allDexes) {
    const info = dex.getInfo ? dex.getInfo() : { name: dex.name, type: dex.type || 'unknown' };
    console.log(`    - ${info.name}: type=${info.type}, quoteSupported=${info.quoteSupported !== false}`);
  }

  // Check for quoteable DEXes
  const quoteableDexes = dexRegistry.getQuoteableDexes ? dexRegistry.getQuoteableDexes() : allDexes;
  console.log(`  Quoteable DEXes: ${quoteableDexes.length}`);

  await provider.destroy();
});

test('DEX contract verification (on-chain)', async () => {
  const provider = await createProvider();
  const dexRegistry = new DexRegistry(provider);

  const dexes = dexRegistry.getAllDexes();
  if (dexes.length === 0) {
    console.log('  No DEXes to verify');
    await provider.destroy();
    return 'SKIP';
  }

  let verified = 0;
  let failed = 0;

  for (const dex of dexes) {
    const routerAddr = dex.routerAddress;
    if (!routerAddr) continue;

    try {
      const code = await provider.getCode(routerAddr);
      if (code && code !== '0x') {
        console.log(`    ✓ ${dex.name} router verified at ${routerAddr.slice(0, 10)}...`);
        verified++;
      } else {
        console.log(`    ✗ ${dex.name} router has no code at ${routerAddr}`);
        failed++;
      }
    } catch (err) {
      console.log(`    ✗ ${dex.name} verification failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`  Verified: ${verified}, Failed: ${failed}`);

  await provider.destroy();
});

// ════════════════════════════════════════════════════════════
// QUOTE TESTS
// ════════════════════════════════════════════════════════════

test('Quote fetching (if DEX and tokens configured)', async () => {
  if (config.watchTokens.length < 2) {
    console.log('  Skipped: Need at least 2 WATCH_TOKENS configured');
    return 'SKIP';
  }

  const provider = await createProvider();
  const dexRegistry = new DexRegistry(provider);

  const quoteableDexes = dexRegistry.getQuoteableDexes
    ? dexRegistry.getQuoteableDexes()
    : dexRegistry.getAllDexes();

  if (quoteableDexes.length === 0) {
    console.log('  Skipped: No quoteable DEXes');
    await provider.destroy();
    return 'SKIP';
  }

  const tokenA = config.watchTokens[0];
  const tokenB = config.watchTokens[1];
  const amountIn = parseAmount('1', 18);

  console.log(`  Testing quotes for ${tokenA.slice(0, 10)}... -> ${tokenB.slice(0, 10)}...`);

  let quotesReceived = 0;

  for (const dex of quoteableDexes) {
    try {
      const quote = await dex.getQuote(tokenA, tokenB, amountIn);
      console.log(`    ✓ ${dex.name}: ${formatAmount(amountIn, 18)} -> ${formatAmount(quote.amountOut, 18)}`);
      if (quote.feeTier) {
        console.log(`      (fee tier: ${quote.feeTier})`);
      }
      quotesReceived++;
    } catch (err) {
      console.log(`    ○ ${dex.name}: ${err.message.slice(0, 50)}...`);
    }
  }

  console.log(`  Quotes received: ${quotesReceived}/${quoteableDexes.length}`);

  await provider.destroy();
});

test('Cross-DEX quote comparison', async () => {
  if (config.watchTokens.length < 2) {
    console.log('  Skipped: Need at least 2 WATCH_TOKENS configured');
    return 'SKIP';
  }

  const provider = await createProvider();
  const dexRegistry = new DexRegistry(provider);

  const quoteableDexes = dexRegistry.getQuoteableDexes
    ? dexRegistry.getQuoteableDexes()
    : dexRegistry.getAllDexes();

  if (quoteableDexes.length < 2) {
    console.log('  Skipped: Need at least 2 quoteable DEXes');
    await provider.destroy();
    return 'SKIP';
  }

  const tokenA = config.watchTokens[0];
  const tokenB = config.watchTokens[1];
  const amountIn = parseAmount('1', 18);

  try {
    const quotes = await dexRegistry.getAllQuotes(tokenA, tokenB, amountIn);

    if (quotes.length < 2) {
      console.log('  Not enough quotes for comparison');
      await provider.destroy();
      return 'SKIP';
    }

    // Sort by output
    quotes.sort((a, b) => {
      if (a.amountOut > b.amountOut) return -1;
      if (a.amountOut < b.amountOut) return 1;
      return 0;
    });

    console.log('  Quote comparison (sorted by output):');
    for (const quote of quotes) {
      console.log(`    ${quote.dex}: ${formatAmount(quote.amountOut, 18)}`);
    }

    // Calculate spread
    const best = quotes[0].amountOut;
    const worst = quotes[quotes.length - 1].amountOut;
    if (worst > 0n) {
      const spreadBps = Number((best - worst) * 10000n / worst);
      console.log(`  Spread: ${(spreadBps / 100).toFixed(2)}%`);
    }

  } catch (err) {
    console.log(`  Quote comparison failed: ${err.message}`);
  }

  await provider.destroy();
});

// ════════════════════════════════════════════════════════════
// SIMULATOR TESTS
// ════════════════════════════════════════════════════════════

test('Simulator initializes', async () => {
  const provider = await createProvider();
  const simulator = new ArbSimulator(provider);

  const stats = simulator.getStats();

  console.log(`  Min net profit: ${stats.minNetProfit}`);
  console.log(`  Min net profit BPS: ${stats.minNetProfitBps}`);
  console.log(`  Max slippage BPS: ${stats.maxSlippageBps}`);
  console.log(`  Gas buffer: ${stats.gasEstimateBuffer}`);

  await provider.destroy();
});

test('Simulator handles mock opportunity with DEX types', async () => {
  const provider = await createProvider();
  const simulator = new ArbSimulator(provider);

  // Create mock opportunity with DEX type information
  const mockOpportunity = {
    blockNumber: 1000000,
    timestamp: Date.now(),
    route: 'spooky->wagmi',
    tokenA: '0x0000000000000000000000000000000000000001',
    tokenB: '0x0000000000000000000000000000000000000002',
    amountIn: parseAmount('1', 18),
    dex1: 'SpookySwap',
    dex2: 'Wagmi',
    dex1Type: 'universal_router',
    dex2Type: 'uniswap_v3',
    isCrossType: true,
    quote1: {
      amountOut: parseAmount('1.1', 18),
      path: [],
      dex: 'SpookySwap',
      type: 'universal_router',
      feeTier: 3000,
    },
    quote2: {
      amountOut: parseAmount('1.2', 18),
      path: [],
      dex: 'Wagmi',
      type: 'uniswap_v3',
      feeTier: 3000,
    },
  };

  const result = await simulator.simulate(mockOpportunity);

  if (!result.decision) throw new Error('Simulation produced no decision');
  if (!result.metrics) throw new Error('Simulation produced no metrics');

  console.log(`  Decision: ${result.decision}`);
  console.log(`  Cross-type route: ${mockOpportunity.isCrossType ? 'YES' : 'NO'}`);
  console.log(`  Reasons: ${result.reasons.length > 0 ? result.reasons.join(', ') : 'None'}`);

  await provider.destroy();
});

// ════════════════════════════════════════════════════════════
// UTILITY TESTS
// ════════════════════════════════════════════════════════════

test('Math utilities work', async () => {
  const { applyBps, subtractBps, formatAmount, parseAmount } = await import('../src/math.js');

  const value = 10000n;
  const bps = 50; // 0.5%

  const result = applyBps(value, bps);
  if (result !== 50n) throw new Error(`Expected 50, got ${result}`);

  const subtracted = subtractBps(value, bps);
  if (subtracted !== 9950n) throw new Error(`Expected 9950, got ${subtracted}`);

  const parsed = parseAmount('1.5', 18);
  const formatted = formatAmount(parsed, 18);
  if (formatted !== '1.5') throw new Error(`Expected "1.5", got "${formatted}"`);

  console.log('  All math operations working ✓');
});

test('Logger writes', async () => {
  logger.info('Test log message');
  logger.debug('Test debug message');
  logger.warn('Test warning message');

  console.log('  Logger operational ✓');
});

// ════════════════════════════════════════════════════════════
// LIVE MODE REQUIREMENTS
// ════════════════════════════════════════════════════════════

test('LIVE mode requirements check', () => {
  if (!isLiveMode()) {
    console.log('  Running in DRY_RUN mode (safe)');
    return;
  }

  // Check LIVE mode requirements
  const errors = [];

  if (!config.privateKey) {
    errors.push('PRIVATE_KEY required');
  }

  if (config.flashloan.type === 'none') {
    errors.push('FLASHLOAN_TYPE must be set for LIVE mode');
  }

  if (config.flashloan.type !== 'none' && !config.flashloan.provider) {
    errors.push('FLASHLOAN_PROVIDER required');
  }

  if (!config.flashloan.receiverContract) {
    errors.push('FLASHLOAN_RECEIVER_CONTRACT required');
  }

  const dexCount = hasDexesConfigured()
    ? Object.keys(config.dexes).length
    : (config.dex1.router ? 1 : 0) + (config.dex2.router ? 1 : 0);

  if (dexCount < 2) {
    errors.push('At least 2 DEXes required');
  }

  if (errors.length > 0) {
    throw new Error('LIVE mode missing: ' + errors.join(', '));
  }

  console.log('  LIVE mode requirements met ✓');
});

// ════════════════════════════════════════════════════════════
// RUN
// ════════════════════════════════════════════════════════════

(async () => {
  try {
    await runTests();

    console.log('');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`  Results: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`);
    console.log('════════════════════════════════════════════════════════════');
    console.log('');

    if (failCount === 0) {
      console.log('✓ All tests passed! Bot is ready to run in DRY_RUN mode.');
      console.log('');
      console.log('Next steps:');
      console.log('  1. Configure your .env file with Sonic DEX addresses');
      console.log('  2. Add WATCH_TOKENS (verified Sonic token addresses)');
      console.log('  3. Run: npm start (will run in DRY_RUN by default)');
      console.log('  4. Complete the LIVE MODE CHECKLIST before enabling LIVE mode');
      console.log('');
      console.log('Quick commands:');
      console.log('  npm start            # Run in DRY_RUN mode');
      console.log('  npm run dry-run      # Explicit dry run');
      console.log('  npm run selftest     # Run this test again');
      console.log('');
      process.exit(0);
    } else {
      console.log('✗ Some tests failed. Please check configuration.');
      console.log('');
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
