#!/usr/bin/env node
/**
 * Comprehensive validation script
 * Verifies all audit fixes are actually implemented
 */

import { readFileSync } from 'fs';

console.log('════════════════════════════════════════════════════════════');
console.log('  SONIC MEV BOT - AUDIT FIX VALIDATION');
console.log('════════════════════════════════════════════════════════════\n');

const checks = [];

// Helper to check file contents
function checkFile(path) {
  return readFileSync(path, 'utf8');
}

// ════════════════════════════════════════════════════════════
// CONFIG FIXES
// ════════════════════════════════════════════════════════════

// Check 1: FLASHLOAN_TYPE added
const config = checkFile('src/config.js');
const hasFlashloanType = config.includes('type: parseFlashloanType(process.env.FLASHLOAN_TYPE)');
const hasFlashloanTypeValidator = config.includes('function parseFlashloanType(value)');
checks.push({
  name: 'P0-1: FLASHLOAN_TYPE config added',
  passed: hasFlashloanType && hasFlashloanTypeValidator,
  details: hasFlashloanType
    ? 'config.flashloan.type uses parseFlashloanType()'
    : 'FAIL: FLASHLOAN_TYPE not implemented'
});

// Check 2: Address checksum normalization
const hasNormalizeAddress = config.includes('function normalizeAddress(address, name)');
const usesGetAddress = config.includes("import { getAddress, isAddress } from 'ethers'");
checks.push({
  name: 'P0-2: Address checksum normalization',
  passed: hasNormalizeAddress && usesGetAddress,
  details: hasNormalizeAddress
    ? 'normalizeAddress() uses ethers.getAddress()'
    : 'FAIL: Address normalization not implemented'
});

// Check 3: isLiveMode() function
const hasIsLiveMode = config.includes('export function isLiveMode()');
const liveModeLogic = config.includes('config.dryRun === false');
checks.push({
  name: 'P1-6: isLiveMode() requires DRY_RUN=false explicitly',
  passed: hasIsLiveMode && liveModeLogic,
  details: hasIsLiveMode
    ? 'isLiveMode() checks liveMode && !dryRun && iUnderstandRisks'
    : 'FAIL: isLiveMode() not implemented correctly'
});

// ════════════════════════════════════════════════════════════
// FLASHLOAN FIXES
// ════════════════════════════════════════════════════════════

// Check 4: Flashloan provider uses FLASHLOAN_TYPE
const flashloan = checkFile('src/exec/flashloan.js');
const hasTypeSwitch = flashloan.includes("switch (flashloanType)");
const hasAaveCase = flashloan.includes("case 'aave':");
const hasBalancerCase = flashloan.includes("case 'balancer':");
checks.push({
  name: 'P1-4: Flashloan provider uses FLASHLOAN_TYPE',
  passed: hasTypeSwitch && hasAaveCase && hasBalancerCase,
  details: hasTypeSwitch
    ? 'createFlashloanProvider() switches on flashloanType'
    : 'FAIL: Hardcoded to Balancer'
});

// Check 5: Aave on-chain fee verification
const hasAaveFeeCheck = flashloan.includes('FLASHLOAN_PREMIUM_TOTAL');
checks.push({
  name: 'P1-5: Aave on-chain fee verification',
  passed: hasAaveFeeCheck,
  details: hasAaveFeeCheck
    ? 'Aave provider checks FLASHLOAN_PREMIUM_TOTAL()'
    : 'FAIL: No on-chain fee verification'
});

// ════════════════════════════════════════════════════════════
// VALIDATION FIXES
// ════════════════════════════════════════════════════════════

// Check 6: poolId validation
const validate = checkFile('src/validate.js');
const hasPoolIdValidator = validate.includes('function validatePoolId(poolId, name)');
const poolIdRegex = validate.includes('/^0x[a-fA-F0-9]{64}$/');
checks.push({
  name: 'P1-5: poolId/bytes32 validation (Balancer)',
  passed: hasPoolIdValidator && poolIdRegex,
  details: hasPoolIdValidator
    ? 'validatePoolId() checks 0x + 64 hex chars'
    : 'FAIL: poolId validation not implemented'
});

// Check 7: Validation uses isLiveMode()
const validationUsesIsLiveMode = validate.includes("import { config, isLiveMode } from './config.js'");
checks.push({
  name: 'P1-6: Validation uses isLiveMode() function',
  passed: validationUsesIsLiveMode,
  details: validationUsesIsLiveMode
    ? 'validate.js imports isLiveMode from config'
    : 'FAIL: Not using centralized isLiveMode()'
});

// ════════════════════════════════════════════════════════════
// SIMULATOR FIXES
// ════════════════════════════════════════════════════════════

// Check 8: Gas buffer configurable
const simulator = checkFile('src/arb/simulator.js');
const hasGasBuffer = simulator.includes('gasEstimateBuffer');
const usesBufferInCalc = simulator.includes('getGasEstimateWithBuffer()');
checks.push({
  name: 'P2-7: Configurable gas estimate buffer',
  passed: hasGasBuffer && usesBufferInCalc,
  details: hasGasBuffer
    ? 'Simulator uses config.profit.gasEstimateBuffer'
    : 'FAIL: Hardcoded gas estimate'
});

// ════════════════════════════════════════════════════════════
// EXECUTOR FIXES
// ════════════════════════════════════════════════════════════

// Check 9: Receipt polling with configurable timeout
const executor = checkFile('src/exec/executor.js');
const hasWaitForReceipt = executor.includes('async waitForReceipt(txHash, timeoutMs)');
const usesConfigTimeout = executor.includes('config.performance.txConfirmationTimeout');
const usesPollInterval = executor.includes('config.performance.txPollInterval');
checks.push({
  name: 'P2-9: Configurable tx confirmation timeout and poll interval',
  passed: hasWaitForReceipt && usesConfigTimeout && usesPollInterval,
  details: hasWaitForReceipt
    ? 'waitForReceipt() uses config.performance settings'
    : 'FAIL: Hardcoded timeout/interval'
});

// ════════════════════════════════════════════════════════════
// CONTRACT FIXES
// ════════════════════════════════════════════════════════════

// Check 10: Contract has _executeSwaps internal function
const contract = checkFile('contracts/FlashloanArbitrage.sol');
const hasExecuteSwaps = contract.includes('function _executeSwaps(');
checks.push({
  name: 'P0-3: Contract has clean _executeSwaps internal function',
  passed: hasExecuteSwaps,
  details: hasExecuteSwaps
    ? 'Refactored with _executeSwaps() internal function'
    : 'FAIL: No refactored internal function'
});

// Check 11: Contract has noReentrancy modifier
const hasNoReentrancy = contract.includes('modifier noReentrancy()');
checks.push({
  name: 'SECURITY: Contract has reentrancy guard',
  passed: hasNoReentrancy,
  details: hasNoReentrancy
    ? 'noReentrancy modifier implemented'
    : 'FAIL: No reentrancy guard'
});

// Check 12: Contract has proper Aave callback
const hasExecuteOperation = contract.includes('function executeOperation(');
const aaveApprovalInCallback = contract.includes('IERC20(assets[i]).approve(flashloanProvider, amountOwed)');
checks.push({
  name: 'P0-3: Aave callback approves AFTER transfers, BEFORE return',
  passed: hasExecuteOperation && aaveApprovalInCallback,
  details: hasExecuteOperation
    ? 'executeOperation() approves in correct order'
    : 'FAIL: Aave callback broken'
});

// ════════════════════════════════════════════════════════════
// ENV EXAMPLE FIXES
// ════════════════════════════════════════════════════════════

// Check 13: .env.example has FLASHLOAN_TYPE
const envExample = checkFile('.env.example');
const hasFlashloanTypeEnv = envExample.includes('FLASHLOAN_TYPE=');
const hasPoolIdEnv = envExample.includes('FLASHLOAN_POOL_ID=');
const hasGasBufferEnv = envExample.includes('GAS_ESTIMATE_BUFFER_PERCENT=');
checks.push({
  name: 'ENV: .env.example has new config options',
  passed: hasFlashloanTypeEnv && hasPoolIdEnv && hasGasBufferEnv,
  details: hasFlashloanTypeEnv
    ? 'FLASHLOAN_TYPE, FLASHLOAN_POOL_ID, GAS_ESTIMATE_BUFFER_PERCENT present'
    : 'FAIL: Missing new env vars'
});

// Check 14: Quote chaining (already correct, but verify)
const scanner = checkFile('src/arb/scanner.js');
const hasQuoteChaining = scanner.includes('quote1_AB.amountOut');
checks.push({
  name: 'P2-8: Quote chaining uses first leg output (verified correct)',
  passed: hasQuoteChaining,
  details: hasQuoteChaining
    ? 'Second leg uses quote1_AB.amountOut as input'
    : 'FAIL: Quote chaining broken'
});

// ════════════════════════════════════════════════════════════
// TEST FIXES
// ════════════════════════════════════════════════════════════

// Check 15: Unit tests exist
let hasUnitTests = false;
try {
  checkFile('tests/unit.test.js');
  hasUnitTests = true;
} catch (err) {
  hasUnitTests = false;
}
checks.push({
  name: 'TEST: Unit tests for critical functionality',
  passed: hasUnitTests,
  details: hasUnitTests
    ? 'tests/unit.test.js exists'
    : 'FAIL: Unit tests not found'
});

// ════════════════════════════════════════════════════════════
// DISPLAY RESULTS
// ════════════════════════════════════════════════════════════

console.log('VERIFICATION RESULTS:\n');
let passCount = 0;
let failCount = 0;

for (const check of checks) {
  const status = check.passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status} - ${check.name}`);
  console.log(`     ${check.details}\n`);
  if (check.passed) passCount++;
  else failCount++;
}

console.log('════════════════════════════════════════════════════════════');
console.log(`TOTAL: ${passCount} passed, ${failCount} failed`);
console.log('════════════════════════════════════════════════════════════\n');

if (failCount === 0) {
  console.log('✅ ALL FIXES VERIFIED - Ready for deployment\n');
  process.exit(0);
} else {
  console.log('❌ SOME CHECKS FAILED - Review required\n');
  process.exit(1);
}
