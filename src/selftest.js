#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// Quick Self-Test Script (src/selftest.js)
// Minimal test to verify DEX registry and basic connectivity
// For full tests, use: npm run selftest
// ════════════════════════════════════════════════════════════

import { config, hasDexesConfigured } from './config.js';
import { createProvider } from './provider.js';
import { DexRegistry } from './dex/dexRegistry.js';
import { parseAmount, formatAmount } from './math.js';

console.log('');
console.log('════════════════════════════════════════════════════════════');
console.log('  SONIC DEX INTEGRATION - QUICK TEST');
console.log('════════════════════════════════════════════════════════════');
console.log('');

async function run() {
  let provider;
  let allPassed = true;

  try {
    // Test 1: Chain ID
    console.log('1. Checking Chain ID...');
    if (config.chainId !== 146) {
      console.log(`   ✗ Expected 146 (Sonic), got ${config.chainId}`);
      allPassed = false;
    } else {
      console.log('   ✓ Chain ID 146 (Sonic)');
    }

    // Test 2: RPC Connectivity
    console.log('2. Checking RPC connectivity...');
    provider = await createProvider();
    const blockNumber = await provider.getBlockNumber();
    const chainId = await provider.getChainId();

    if (chainId !== 146) {
      console.log(`   ✗ RPC chain ID mismatch: ${chainId}`);
      allPassed = false;
    } else {
      console.log(`   ✓ Connected to Sonic at block ${blockNumber}`);
    }

    // Test 3: DEX Registry
    console.log('3. Checking DEX registry...');
    const dexRegistry = new DexRegistry(provider);
    const dexCount = dexRegistry.getDexCount();

    if (dexCount === 0) {
      console.log('   ⊘ No DEXes configured');
    } else {
      console.log(`   ✓ ${dexCount} DEXes registered`);

      // Show DEX info
      const dexes = dexRegistry.getAllDexes();
      for (const dex of dexes) {
        const info = dex.getInfo ? dex.getInfo() : { name: dex.name, type: 'unknown' };
        console.log(`     - ${info.name}: ${info.type} (quote: ${info.quoteSupported ? 'yes' : 'no'})`);
      }
    }

    // Test 4: Contract verification
    console.log('4. Verifying DEX contracts on-chain...');
    const dexes = dexRegistry.getAllDexes();
    let verified = 0;

    for (const dex of dexes) {
      if (dex.routerAddress) {
        try {
          const code = await provider.getCode(dex.routerAddress);
          if (code && code !== '0x') {
            console.log(`     ✓ ${dex.name} router has code`);
            verified++;
          } else {
            console.log(`     ✗ ${dex.name} router has NO code`);
            allPassed = false;
          }
        } catch (err) {
          console.log(`     ✗ ${dex.name}: ${err.message}`);
          allPassed = false;
        }
      }
    }

    // Test 5: Quote test (if tokens configured)
    console.log('5. Testing quote functionality...');
    if (config.watchTokens.length >= 2 && dexCount > 0) {
      const tokenA = config.watchTokens[0];
      const tokenB = config.watchTokens[1];
      const amountIn = parseAmount('1', 18);

      console.log(`   Testing: ${tokenA.slice(0, 10)}... -> ${tokenB.slice(0, 10)}...`);

      const quoteableDexes = dexRegistry.getQuoteableDexes();
      let quotesReceived = 0;

      for (const dex of quoteableDexes) {
        try {
          const quote = await dex.getQuote(tokenA, tokenB, amountIn);
          console.log(`     ✓ ${dex.name}: 1.0 -> ${formatAmount(quote.amountOut, 18)}`);
          quotesReceived++;
        } catch (err) {
          console.log(`     ○ ${dex.name}: ${err.message.slice(0, 40)}...`);
        }
      }

      if (quotesReceived > 0) {
        console.log(`   ✓ Received ${quotesReceived} quotes`);
      } else {
        console.log('   ⊘ No quotes received (pairs may not exist)');
      }
    } else {
      console.log('   ⊘ Skipped: Need WATCH_TOKENS and DEXes configured');
    }

    // Summary
    console.log('');
    console.log('════════════════════════════════════════════════════════════');
    if (allPassed) {
      console.log('  ✓ PASS - All checks passed!');
      console.log('');
      console.log('  To run the bot:');
      console.log('    DRY_RUN=true npm start');
      console.log('');
      console.log('  For full test suite:');
      console.log('    npm run selftest');
    } else {
      console.log('  ✗ FAIL - Some checks failed');
      console.log('  Please review your .env configuration');
    }
    console.log('════════════════════════════════════════════════════════════');
    console.log('');

  } catch (err) {
    console.error('');
    console.error('Fatal error:', err.message);
    allPassed = false;
  } finally {
    if (provider) {
      await provider.destroy();
    }
  }

  process.exit(allPassed ? 0 : 1);
}

run();
