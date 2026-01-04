#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// Self-Test Script
// Validates bot setup and configuration without running live
// ════════════════════════════════════════════════════════════

import { config, isLiveMode } from '../src/config.js';
import { logger } from '../src/logger.js';
import { createProvider } from '../src/provider.js';
import { DexRegistry } from '../src/dex/dexRegistry.js';
import { ArbSimulator } from '../src/arb/simulator.js';
import { parseAmount } from '../src/math.js';
import { validatePoolId } from '../src/validate.js';

console.log('');
console.log('════════════════════════════════════════════════════════════');
console.log('  SONIC MEV BOT - SELF TEST');
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
// TESTS
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

test('FLASHLOAN_TYPE validation', () => {
  const validTypes = ['none', 'balancer', 'aave'];
  const flashloanType = config.flashloan.type;

  if (!validTypes.includes(flashloanType)) {
    throw new Error(`Invalid FLASHLOAN_TYPE: ${flashloanType}`);
  }

  console.log(`  FLASHLOAN_TYPE: ${flashloanType}`);

  if (flashloanType !== 'none') {
    if (!config.flashloan.provider) {
      console.log('  WARNING: FLASHLOAN_PROVIDER not set for non-none type');
    } else {
      console.log(`  FLASHLOAN_PROVIDER: ${config.flashloan.provider}`);
    }
  }
});

test('PoolId format validation (if set)', () => {
  const poolId = config.flashloan.poolId;

  if (poolId) {
    validatePoolId(poolId, 'FLASHLOAN_POOL_ID');
    console.log(`  PoolId valid: ${poolId.slice(0, 10)}...`);
  } else {
    console.log('  PoolId not set (optional)');
  }
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

  console.log(`  Chain ID verified: ${chainId} ✓`);

  await provider.destroy();
});

test('DEX adapters initialize', async () => {
  const provider = await createProvider();
  const dexRegistry = new DexRegistry(provider);

  const dexes = dexRegistry.getAllDexes();
  if (dexes.length === 0) throw new Error('No DEXes initialized');

  console.log(`  DEX count: ${dexes.length}`);
  for (const dex of dexes) {
    const hasRouter = dex.routerAddress ? '✓' : '✗';
    console.log(`    - ${dex.name} (fee: ${dex.feeBps} bps) Router: ${hasRouter}`);
  }

  await provider.destroy();
});

test('Quote fetching (if DEX configured)', async () => {
  if (!config.dex1.router || config.watchTokens.length < 2) {
    console.log('  Skipped: DEX or tokens not fully configured');
    return 'SKIP';
  }

  const provider = await createProvider();
  const dexRegistry = new DexRegistry(provider);
  const dex1 = dexRegistry.getDex('dex1');

  if (!dex1) {
    console.log('  Skipped: DEX1 not available');
    await provider.destroy();
    return 'SKIP';
  }

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

test('Simulator handles mock opportunity', async () => {
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

  if (!config.dex1.router) {
    errors.push('DEX1_ROUTER required');
  }

  if (!config.dex2.router) {
    errors.push('DEX2_ROUTER required');
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
      console.log('  1. Configure your .env file with real Sonic addresses');
      console.log('  2. Run: npm start (will run in DRY_RUN by default)');
      console.log('  3. Complete the LIVE MODE CHECKLIST before enabling LIVE mode');
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
