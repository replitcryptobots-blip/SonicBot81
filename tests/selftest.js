#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// Self-Test Script
// Validates bot setup without running live
// ════════════════════════════════════════════════════════════

import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { createProvider } from '../src/provider.js';
import { DexRegistry } from '../src/dex/dexRegistry.js';
import { ArbSimulator } from '../src/arb/simulator.js';
import { parseAmount } from '../src/math.js';

console.log('');
console.log('════════════════════════════════════════════════════════════');
console.log('  SONIC MEV BOT - SELF TEST');
console.log('════════════════════════════════════════════════════════════');
console.log('');

const tests = [];
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  for (const { name, fn } of tests) {
    try {
      console.log(`Testing: ${name}...`);
      await fn();
      console.log(`✓ ${name} passed`);
      passCount++;
    } catch (err) {
      console.error(`✗ ${name} failed:`, err.message);
      failCount++;
    }
  }
}

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

test('Config loads', () => {
  if (!config.chainId) throw new Error('Chain ID not loaded');
  if (config.rpcUrls.length === 0) throw new Error('No RPC URLs configured');
  console.log(`  Chain ID: ${config.chainId}`);
  console.log(`  RPC URLs: ${config.rpcUrls.length}`);
});

test('RPC connectivity', async () => {
  const provider = await createProvider();

  const blockNumber = await provider.getBlockNumber();
  if (!blockNumber) throw new Error('Failed to get block number');

  console.log(`  Current block: ${blockNumber}`);

  const chainId = await provider.getChainId();
  if (chainId !== config.chainId) {
    throw new Error(`Chain ID mismatch: expected ${config.chainId}, got ${chainId}`);
  }

  console.log(`  Chain ID: ${chainId} ✓`);

  await provider.destroy();
});

test('DEX adapters initialize', async () => {
  const provider = await createProvider();
  const dexRegistry = new DexRegistry(provider);

  const dexes = dexRegistry.getAllDexes();
  if (dexes.length === 0) throw new Error('No DEXes initialized');

  console.log(`  DEX count: ${dexes.length}`);
  for (const dex of dexes) {
    console.log(`    - ${dex.name} (fee: ${dex.feeBps} bps)`);
  }

  await provider.destroy();
});

test('Quote fetching (if configured)', async () => {
  if (!config.dex1.router || config.watchTokens.length < 2) {
    console.log('  Skipped: DEX or tokens not configured');
    return;
  }

  const provider = await createProvider();
  const dexRegistry = new DexRegistry(provider);
  const dex1 = dexRegistry.getDex('dex1');

  const tokenA = config.watchTokens[0];
  const tokenB = config.watchTokens[1];
  const amountIn = parseAmount('1', 18);

  try {
    const quote = await dex1.getQuote(tokenA, tokenB, amountIn);
    console.log(`  Quote: ${amountIn} -> ${quote.amountOut}`);
  } catch (err) {
    console.log(`  Note: Quote failed (${err.message}) - may be normal if pair doesn't exist`);
  }

  await provider.destroy();
});

test('Simulator runs', async () => {
  const provider = await createProvider();
  const simulator = new ArbSimulator(provider);

  // Create mock opportunity
  const mockOpportunity = {
    blockNumber: 1000000,
    timestamp: Date.now(),
    route: 'test',
    tokenA: '0x0000000000000000000000000000000000000001',
    tokenB: '0x0000000000000000000000000000000000000002',
    amountIn: parseAmount('1', 18),
    dex1: 'DEX1',
    dex2: 'DEX2',
    quote1: {
      amountOut: parseAmount('1.1', 18),
      path: [],
      dex: 'DEX1',
    },
    quote2: {
      amountOut: parseAmount('1.2', 18),
      path: [],
      dex: 'DEX2',
    },
  };

  const result = await simulator.simulate(mockOpportunity);

  if (!result.decision) throw new Error('Simulation produced no decision');
  if (!result.metrics) throw new Error('Simulation produced no metrics');

  console.log(`  Decision: ${result.decision}`);
  console.log(`  Reasons: ${result.reasons.length > 0 ? result.reasons.join(', ') : 'None'}`);

  await provider.destroy();
});

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
// RUN
// ════════════════════════════════════════════════════════════

(async () => {
  try {
    await runTests();

    console.log('');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`  Results: ${passCount} passed, ${failCount} failed`);
    console.log('════════════════════════════════════════════════════════════');
    console.log('');

    if (failCount === 0) {
      console.log('✓ All tests passed! Bot is ready to run in DRY_RUN mode.');
      console.log('');
      console.log('Next steps:');
      console.log('  1. Configure your .env file with real addresses');
      console.log('  2. Run: npm start (will run in DRY_RUN by default)');
      console.log('  3. Verify the verification checklist before LIVE mode');
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
