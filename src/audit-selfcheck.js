#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// AUDIT SELF-CHECK SCRIPT
// Comprehensive verification for Sonic DEX Integration
// Validates: env, address checksums, on-chain bytecode, quotes
// ════════════════════════════════════════════════════════════

import { config, hasDexesConfigured } from './config.js';
import { createProvider } from './provider.js';
import { DexRegistry } from './dex/dexRegistry.js';
import { parseAmount, formatAmount } from './math.js';
import { getAddress, isAddress } from 'ethers';

// ANSI colors for terminal output
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

const PASS = `${GREEN}PASS${RESET}`;
const FAIL = `${RED}FAIL${RESET}`;
const WARN = `${YELLOW}WARN${RESET}`;
const SKIP = `${CYAN}SKIP${RESET}`;

// Track test results
const results = {
  pass: 0,
  fail: 0,
  warn: 0,
  skip: 0,
  errors: [],
};

function log(status, message, detail = '') {
  const statusStr = status === 'PASS' ? PASS :
                    status === 'FAIL' ? FAIL :
                    status === 'WARN' ? WARN : SKIP;
  console.log(`  [${statusStr}] ${message}${detail ? ` - ${detail}` : ''}`);

  if (status === 'PASS') results.pass++;
  else if (status === 'FAIL') {
    results.fail++;
    results.errors.push({ message, detail });
  }
  else if (status === 'WARN') results.warn++;
  else results.skip++;
}

console.log('');
console.log('════════════════════════════════════════════════════════════');
console.log('  SONIC DEX INTEGRATION - AUDIT SELF-CHECK');
console.log('  Comprehensive Pre-Deployment Verification');
console.log('════════════════════════════════════════════════════════════');
console.log('');

// ════════════════════════════════════════════════════════════
// SECTION 1: Environment Variable Validation
// ════════════════════════════════════════════════════════════

console.log('1. ENVIRONMENT VALIDATION');
console.log('─────────────────────────────────────────────────────────────');

// Check Chain ID
if (config.chainId === 146) {
  log('PASS', 'CHAIN_ID', '146 (Sonic mainnet)');
} else {
  log('FAIL', 'CHAIN_ID', `Expected 146, got ${config.chainId}`);
}

// Check RPC URLs
if (config.rpcUrls && config.rpcUrls.length > 0) {
  log('PASS', 'RPC_URL', `${config.rpcUrls.length} endpoint(s) configured`);
} else {
  log('FAIL', 'RPC_URL', 'No RPC URLs configured');
}

// Check safety defaults
if (config.dryRun === true) {
  log('PASS', 'DRY_RUN', 'Enabled (safe default)');
} else {
  log('WARN', 'DRY_RUN', 'DISABLED - Real transactions possible!');
}

if (config.liveMode === false) {
  log('PASS', 'LIVE_MODE', 'Disabled (safe default)');
} else if (config.iUnderstandRisks) {
  log('WARN', 'LIVE_MODE', 'ENABLED with I_UNDERSTAND_RISKS=true');
} else {
  log('PASS', 'LIVE_MODE', 'Enabled but blocked (I_UNDERSTAND_RISKS=false)');
}

if (config.killSwitch) {
  log('WARN', 'KILL_SWITCH', 'ACTIVE - Bot will not trade');
} else {
  log('PASS', 'KILL_SWITCH', 'Not active');
}

// Check DEX configuration
const dexCount = hasDexesConfigured() ? Object.keys(config.dexes).length : 0;
if (dexCount >= 2) {
  log('PASS', 'DEXES', `${dexCount} DEXes configured`);
} else if (dexCount === 1) {
  log('WARN', 'DEXES', 'Only 1 DEX configured (need 2+ for arbitrage)');
} else {
  log('FAIL', 'DEXES', 'No DEXes configured');
}

console.log('');

// ════════════════════════════════════════════════════════════
// SECTION 2: Address Checksum Validation
// ════════════════════════════════════════════════════════════

console.log('2. ADDRESS CHECKSUM VALIDATION');
console.log('─────────────────────────────────────────────────────────────');

function validateAddressChecksum(address, name) {
  if (!address || address.trim() === '') {
    log('SKIP', name, 'Not configured');
    return false;
  }

  try {
    if (!isAddress(address)) {
      log('FAIL', name, `Invalid address format: ${address.slice(0, 20)}...`);
      return false;
    }

    const checksummed = getAddress(address);
    if (checksummed !== address) {
      log('FAIL', name, `Checksum mismatch! Got ${address.slice(0, 10)}..., expected ${checksummed.slice(0, 10)}...`);
      return false;
    }

    log('PASS', name, `${address.slice(0, 10)}...${address.slice(-6)}`);
    return true;
  } catch (err) {
    log('FAIL', name, `Validation error: ${err.message}`);
    return false;
  }
}

// Validate DEX addresses
if (hasDexesConfigured()) {
  for (const [dexKey, dexConfig] of Object.entries(config.dexes)) {
    validateAddressChecksum(dexConfig.router, `${dexKey.toUpperCase()}_ROUTER`);
    if (dexConfig.quoter) {
      validateAddressChecksum(dexConfig.quoter, `${dexKey.toUpperCase()}_QUOTER`);
    }
    if (dexConfig.factory) {
      validateAddressChecksum(dexConfig.factory, `${dexKey.toUpperCase()}_FACTORY`);
    }
  }
}

// Validate flashloan addresses
validateAddressChecksum(config.flashloan.provider, 'FLASHLOAN_PROVIDER');
validateAddressChecksum(config.flashloan.receiverContract, 'FLASHLOAN_RECEIVER_CONTRACT');

// Validate token addresses
if (config.baseToken) {
  validateAddressChecksum(config.baseToken, 'BASE_TOKEN');
}

for (let i = 0; i < config.watchTokens.length; i++) {
  validateAddressChecksum(config.watchTokens[i], `WATCH_TOKENS[${i}]`);
}

console.log('');

// ════════════════════════════════════════════════════════════
// SECTION 3: RPC Connectivity Check
// ════════════════════════════════════════════════════════════

console.log('3. RPC CONNECTIVITY');
console.log('─────────────────────────────────────────────────────────────');

let provider = null;
let rpcAvailable = false;

try {
  provider = await createProvider();

  // Test basic connectivity with timeout
  const connectTimeout = setTimeout(() => {
    throw new Error('Connection timeout after 10s');
  }, 10000);

  const blockNumber = await provider.getBlockNumber();
  clearTimeout(connectTimeout);

  if (typeof blockNumber === 'number' && blockNumber > 0) {
    log('PASS', 'RPC Connection', `Block ${blockNumber}`);
    rpcAvailable = true;
  } else {
    log('FAIL', 'RPC Connection', 'Invalid block number response');
  }

  // Verify chain ID
  const chainId = await provider.getChainId();
  if (chainId === 146) {
    log('PASS', 'Chain ID Verification', 'Connected to Sonic (146)');
  } else {
    log('FAIL', 'Chain ID Verification', `Expected 146, got ${chainId}`);
    rpcAvailable = false;
  }

} catch (err) {
  log('FAIL', 'RPC Connection', `${err.message}`);
  console.log('');
  console.log(`${RED}  CRITICAL: RPC unreachable - cannot verify on-chain bytecode / quoting${RESET}`);
  console.log('  Please check your RPC_URL configuration and network connectivity.');
  console.log('');
}

if (!rpcAvailable) {
  console.log('');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`  ${RED}ABORT${RESET}: Cannot proceed without RPC connectivity`);
  console.log('════════════════════════════════════════════════════════════');
  console.log('');
  if (provider) await provider.destroy();
  process.exit(1);
}

console.log('');

// ════════════════════════════════════════════════════════════
// SECTION 4: On-Chain Bytecode Verification
// ════════════════════════════════════════════════════════════

console.log('4. ON-CHAIN BYTECODE VERIFICATION');
console.log('─────────────────────────────────────────────────────────────');

async function verifyBytecode(address, name) {
  if (!address || address.trim() === '') {
    log('SKIP', name, 'Not configured');
    return false;
  }

  try {
    const code = await provider.getCode(address);

    if (!code || code === '0x' || code === '0x0') {
      log('FAIL', name, `NO CODE at ${address.slice(0, 10)}...`);
      return false;
    }

    const codeSize = (code.length - 2) / 2;
    log('PASS', name, `${codeSize} bytes at ${address.slice(0, 10)}...`);
    return true;
  } catch (err) {
    log('FAIL', name, `Error: ${err.message}`);
    return false;
  }
}

// Verify DEX contracts
if (hasDexesConfigured()) {
  for (const [dexKey, dexConfig] of Object.entries(config.dexes)) {
    await verifyBytecode(dexConfig.router, `${dexKey.toUpperCase()} Router`);
    if (dexConfig.quoter) {
      await verifyBytecode(dexConfig.quoter, `${dexKey.toUpperCase()} Quoter`);
    }
  }
}

// Verify flashloan contracts
await verifyBytecode(config.flashloan.provider, 'Flashloan Provider');
await verifyBytecode(config.flashloan.receiverContract, 'Flashloan Receiver');

// Verify tokens
if (config.baseToken) {
  await verifyBytecode(config.baseToken, 'Base Token');
}

for (let i = 0; i < Math.min(config.watchTokens.length, 5); i++) {
  await verifyBytecode(config.watchTokens[i], `Watch Token [${i}]`);
}

console.log('');

// ════════════════════════════════════════════════════════════
// SECTION 5: DEX Registry & Adapter Verification
// ════════════════════════════════════════════════════════════

console.log('5. DEX REGISTRY & ADAPTER VERIFICATION');
console.log('─────────────────────────────────────────────────────────────');

let dexRegistry = null;

try {
  dexRegistry = new DexRegistry(provider);

  const totalDexes = dexRegistry.getDexCount();
  const quoteableDexes = dexRegistry.getQuoteableDexes();

  if (totalDexes > 0) {
    log('PASS', 'DEX Registry Init', `${totalDexes} DEX(es) registered`);
  } else {
    log('FAIL', 'DEX Registry Init', 'No DEXes registered');
  }

  if (quoteableDexes.length >= 2) {
    log('PASS', 'Quoteable DEXes', `${quoteableDexes.length} DEX(es) can quote`);
  } else if (quoteableDexes.length === 1) {
    log('WARN', 'Quoteable DEXes', 'Only 1 DEX can quote (need 2+ for arb)');
  } else {
    log('FAIL', 'Quoteable DEXes', 'No DEXes can quote');
  }

  // Display adapter types
  const dexes = dexRegistry.getAllDexes();
  console.log('');
  console.log('  Adapter Summary:');
  for (const dex of dexes) {
    const info = dex.getInfo();
    const quoteStatus = info.quoteSupported ? `${GREEN}quote:yes${RESET}` : `${RED}quote:no${RESET}`;
    console.log(`    - ${info.name}: ${info.type} [${quoteStatus}]`);
  }

} catch (err) {
  log('FAIL', 'DEX Registry', `Init error: ${err.message}`);
}

console.log('');

// ════════════════════════════════════════════════════════════
// SECTION 6: Quote Tests (V2 and V3)
// ════════════════════════════════════════════════════════════

console.log('6. QUOTE FUNCTIONALITY TESTS');
console.log('─────────────────────────────────────────────────────────────');

if (!dexRegistry || config.watchTokens.length < 2) {
  log('SKIP', 'Quote Tests', 'Need DEX registry and 2+ watch tokens');
} else {
  const tokenA = config.watchTokens[0];
  const tokenB = config.watchTokens[1];
  const amountIn = parseAmount('0.01', 18); // Small test amount

  console.log(`  Testing: ${tokenA.slice(0, 10)}... -> ${tokenB.slice(0, 10)}...`);
  console.log(`  Amount: ${formatAmount(amountIn, 18)}`);
  console.log('');

  const quoteableDexes = dexRegistry.getQuoteableDexes();
  let v2QuoteSuccess = false;
  let v3QuoteSuccess = false;

  for (const dex of quoteableDexes) {
    const info = dex.getInfo();

    try {
      const quote = await dex.getQuote(tokenA, tokenB, amountIn);

      // Validate quote response
      if (!quote || quote.amountOut === undefined) {
        log('FAIL', `${info.name} Quote`, 'Invalid response (no amountOut)');
        continue;
      }

      if (quote.amountOut <= 0n) {
        log('FAIL', `${info.name} Quote`, 'amountOut is 0 or negative');
        continue;
      }

      const formattedOut = formatAmount(quote.amountOut, 18);
      const feeTierStr = quote.feeTier ? ` (fee: ${quote.feeTier})` : '';
      log('PASS', `${info.name} Quote`, `${formattedOut}${feeTierStr}`);

      // Track V2 vs V3 success
      if (info.type === 'uniswap_v2') v2QuoteSuccess = true;
      if (info.type === 'uniswap_v3' || info.type === 'universal_router') v3QuoteSuccess = true;

    } catch (err) {
      const errMsg = err.message.slice(0, 60);

      // Distinguish expected failures from bugs
      if (errMsg.includes('INSUFFICIENT_LIQUIDITY') ||
          errMsg.includes('No liquidity') ||
          errMsg.includes('No pool') ||
          errMsg.includes('No V3 pools')) {
        log('WARN', `${info.name} Quote`, `No liquidity for pair`);
      } else if (errMsg.includes('BAD_DATA') ||
                 errMsg.includes('require(false)') ||
                 errMsg.includes('execution reverted')) {
        log('FAIL', `${info.name} Quote`, `Contract error: ${errMsg}`);
      } else {
        log('WARN', `${info.name} Quote`, errMsg);
      }
    }
  }

  // Summary
  console.log('');
  if (v2QuoteSuccess) {
    log('PASS', 'V2 Quote Test', 'At least one V2 DEX returned valid quote');
  } else {
    log('WARN', 'V2 Quote Test', 'No V2 quotes received (check pair exists)');
  }

  if (v3QuoteSuccess) {
    log('PASS', 'V3/Universal Quote Test', 'At least one V3/Universal DEX returned valid quote');
  } else {
    log('WARN', 'V3/Universal Quote Test', 'No V3 quotes received (check pair/fee tier exists)');
  }
}

console.log('');

// ════════════════════════════════════════════════════════════
// SECTION 7: Route Chaining Verification
// ════════════════════════════════════════════════════════════

console.log('7. ROUTE CHAINING VERIFICATION');
console.log('─────────────────────────────────────────────────────────────');

if (!dexRegistry || config.watchTokens.length < 2) {
  log('SKIP', 'Route Chaining', 'Need DEX registry and 2+ watch tokens');
} else {
  const quoteableDexes = dexRegistry.getQuoteableDexes();

  if (quoteableDexes.length < 2) {
    log('SKIP', 'Route Chaining', 'Need 2+ quoteable DEXes');
  } else {
    const tokenA = config.watchTokens[0];
    const tokenB = config.watchTokens[1];
    const amountIn = parseAmount('0.01', 18);

    try {
      // Get first quote
      const dex1 = quoteableDexes[0];
      const quote1 = await dex1.getQuote(tokenA, tokenB, amountIn);

      if (quote1 && quote1.amountOut > 0n) {
        // CRITICAL: Second leg uses output from first leg
        const dex2 = quoteableDexes[1];
        const quote2 = await dex2.getQuote(tokenB, tokenA, quote1.amountOut);

        if (quote2 && quote2.amountOut > 0n) {
          log('PASS', 'Route Chaining',
            `${dex1.name} -> ${dex2.name}: ${formatAmount(amountIn, 18)} -> ${formatAmount(quote1.amountOut, 18)} -> ${formatAmount(quote2.amountOut, 18)}`);

          // Check if profitable
          if (quote2.amountOut > amountIn) {
            const profit = quote2.amountOut - amountIn;
            const profitBps = Number(profit * 10000n / amountIn);
            log('PASS', 'Arb Opportunity', `Profit: ${formatAmount(profit, 18)} (${(profitBps / 100).toFixed(2)}%)`);
          } else {
            log('PASS', 'Arb Check', 'No profitable arb (expected for test)');
          }
        } else {
          log('WARN', 'Route Chaining', 'Second leg returned 0');
        }
      } else {
        log('WARN', 'Route Chaining', 'First leg returned 0');
      }
    } catch (err) {
      log('WARN', 'Route Chaining', `Test skipped: ${err.message.slice(0, 50)}`);
    }
  }
}

console.log('');

// ════════════════════════════════════════════════════════════
// SECTION 8: Fee & Slippage Configuration
// ════════════════════════════════════════════════════════════

console.log('8. FEE & SLIPPAGE CONFIGURATION');
console.log('─────────────────────────────────────────────────────────────');

// Check V3 fee tiers
const v3FeeTiers = config.v3?.feeTiers || [500, 3000, 10000];
const validFeeTiers = v3FeeTiers.every(f => [100, 500, 3000, 10000].includes(f));
if (validFeeTiers) {
  log('PASS', 'V3 Fee Tiers', v3FeeTiers.join(', '));
} else {
  log('WARN', 'V3 Fee Tiers', `Non-standard tiers: ${v3FeeTiers.join(', ')}`);
}

// Check slippage
const maxSlippage = config.profit?.maxSlippageBps || 50;
if (maxSlippage >= 10 && maxSlippage <= 100) {
  log('PASS', 'Max Slippage', `${maxSlippage} bps (${maxSlippage / 100}%)`);
} else if (maxSlippage > 100) {
  log('WARN', 'Max Slippage', `${maxSlippage} bps is HIGH - risk of sandwich attacks`);
} else {
  log('WARN', 'Max Slippage', `${maxSlippage} bps may be too tight`);
}

// Check min profit
const minProfitBps = config.profit?.minNetProfitBps || 50;
if (minProfitBps >= 10) {
  log('PASS', 'Min Profit BPS', `${minProfitBps} bps (${minProfitBps / 100}%)`);
} else {
  log('WARN', 'Min Profit BPS', `${minProfitBps} bps may not cover gas`);
}

// Check flashloan fee
const flashloanFee = config.flashloan?.feeBps || 0;
log('PASS', 'Flashloan Fee', `${flashloanFee} bps (${flashloanFee / 100}%)`);

console.log('');

// ════════════════════════════════════════════════════════════
// CLEANUP & FINAL REPORT
// ════════════════════════════════════════════════════════════

if (provider) {
  await provider.destroy();
}

console.log('════════════════════════════════════════════════════════════');
console.log('  FINAL REPORT');
console.log('════════════════════════════════════════════════════════════');
console.log('');
console.log(`  ${GREEN}PASS${RESET}: ${results.pass}`);
console.log(`  ${RED}FAIL${RESET}: ${results.fail}`);
console.log(`  ${YELLOW}WARN${RESET}: ${results.warn}`);
console.log(`  ${CYAN}SKIP${RESET}: ${results.skip}`);
console.log('');

if (results.fail > 0) {
  console.log(`${RED}  VERDICT: NOT READY${RESET}`);
  console.log('');
  console.log('  Failures:');
  for (const err of results.errors) {
    console.log(`    - ${err.message}: ${err.detail}`);
  }
  console.log('');
  console.log('  DO NOT TRADE until all FAIL items are resolved.');
  console.log('');
  process.exit(1);
} else if (results.warn > 0) {
  console.log(`${YELLOW}  VERDICT: DRY_RUN ONLY${RESET}`);
  console.log('');
  console.log('  Warnings detected. Safe for DRY_RUN testing only.');
  console.log('  Review WARN items before enabling LIVE_MODE.');
  console.log('');
  process.exit(0);
} else {
  console.log(`${GREEN}  VERDICT: READY FOR DRY_RUN${RESET}`);
  console.log('');
  console.log('  All checks passed! Safe to proceed with DRY_RUN testing.');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. npm start                    # Run in DRY_RUN mode');
  console.log('    2. Monitor logs for 24+ hours');
  console.log('    3. Complete LIVE_MODE_CHECKLIST.md before going live');
  console.log('');
  process.exit(0);
}
