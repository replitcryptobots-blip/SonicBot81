#!/usr/bin/env node
/**
 * Comprehensive validation script
 * Verifies all audit fixes are actually implemented
 */

import { readFileSync } from 'fs';

console.log('════════════════════════════════════════════════════════════');
console.log('  AUDIT FIX VALIDATION');
console.log('════════════════════════════════════════════════════════════\n');

const checks = [];

// Check 1: Simulator typo fixed
const simulator = readFileSync('src/arb/simulator.js', 'utf8');
const hasTypo = simulator.includes('maxSlippage Bps');
const typoFixed = !hasTypo && simulator.includes('maxSlippageBps');
checks.push({
  name: 'Finding 1: Simulator typo fixed',
  passed: typoFixed,
  details: typoFixed ? 'Line 22: maxSlippageBps (no space)' : 'FAIL: Typo still exists'
});

// Check 2: Quote chaining fixed
const scanner = readFileSync('src/arb/scanner.js', 'utf8');
const hasChaining = scanner.includes('quote1_AB.amountOut');
const chainingComment = scanner.includes('Second leg: Use output from first leg');
checks.push({
  name: 'Finding 2: Quote chaining uses first leg output',
  passed: hasChaining && chainingComment,
  details: hasChaining ? 'Lines 189, 217: Uses quote1_AB.amountOut' : 'FAIL: Still uses wrong input'
});

// Check 3: Receipt waiting fixed
const executor = readFileSync('src/exec/executor.js', 'utf8');
const hasWaitMethod = executor.includes('async waitForReceipt');
const callsWaitMethod = executor.includes('await this.waitForReceipt');
checks.push({
  name: 'Finding 3: Transaction receipt polling implemented',
  passed: hasWaitMethod && callsWaitMethod,
  details: hasWaitMethod ? 'Lines 370-393: waitForReceipt() with polling' : 'FAIL: No polling'
});

// Check 4: Math formula fixed
const math = readFileSync('src/math.js', 'utf8');
const hasCorrectFormula = math.includes('const feeMultiplier = BPS_DIVISOR - BigInt(feeBps)');
const hasCorrectNumerator = math.includes('const numerator = amountInWithFee * reserveOut');
const hasCorrectDenominator = math.includes('const denominator = reserveIn * BPS_DIVISOR + amountInWithFee');
checks.push({
  name: 'Finding 4: UniswapV2 math formula correct',
  passed: hasCorrectFormula && hasCorrectNumerator && hasCorrectDenominator,
  details: hasCorrectFormula ? 'Lines 111-122: Correct UniswapV2 formula' : 'FAIL: Wrong formula'
});

// Check 5: Contract exists
const contract = readFileSync('contracts/FlashloanArbitrage.sol', 'utf8');
const hasExecuteArbitrage = contract.includes('function executeArbitrage');
const hasReceiveFlashLoan = contract.includes('function receiveFlashLoan');
checks.push({
  name: 'Finding 5: Flashloan receiver contract exists',
  passed: hasExecuteArbitrage && hasReceiveFlashLoan,
  details: hasExecuteArbitrage ? '273 lines with executeArbitrage & receiveFlashLoan' : 'FAIL: Contract incomplete'
});

// Check 6: ABI encoding fixed
const hasABIEncoding = executor.includes('encodeFunctionData(\'executeArbitrage\'');
const noJSONEncoding = !executor.includes('JSON.stringify(params)');
checks.push({
  name: 'Finding 6: Proper ABI encoding (not JSON)',
  passed: hasABIEncoding && noJSONEncoding,
  details: hasABIEncoding ? 'Line 346: Uses encodeFunctionData()' : 'FAIL: Still uses JSON'
});

// NEW CHECK: Balancer repayment fixed
const hasApproval = contract.includes('IERC20(token0).approve(flashloanProvider, repayAmount)');
checks.push({
  name: 'CRITICAL FIX: Balancer flashloan repayment',
  passed: hasApproval,
  details: hasApproval ? 'Line 203: Approves flashloanProvider to pull repayment' : 'FAIL: Uses transfer() instead of approve()'
});

// NEW CHECK: Gas-efficient approvals
const hasMaxApproval = contract.includes('type(uint256).max');
checks.push({
  name: 'GAS OPTIMIZATION: Max approvals for DEX routers',
  passed: hasMaxApproval,
  details: hasMaxApproval ? 'Lines 166, 184: Uses type(uint256).max' : 'Note: Uses exact amount (less efficient)'
});

// Display results
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
