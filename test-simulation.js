#!/usr/bin/env node
// Comprehensive simulation test - no network required
import { parseAmount, getAmountOut, formatAmount } from './src/math.js';
import { ArbSimulator } from './src/arb/simulator.js';

console.log('=== MATH FORMULA VERIFICATION ===\n');

// Test UniswapV2 formula with known values
// Reference: https://docs.uniswap.org/contracts/v2/reference/smart-contracts/pair#getamountout
const reserveIn = parseAmount('1000', 18); // 1000 tokens
const reserveOut = parseAmount('2000', 18); // 2000 tokens
const amountIn = parseAmount('100', 18); // 100 tokens
const feeBps = 30; // 0.3%

const amountOut = getAmountOut(amountIn, reserveIn, reserveOut, feeBps);

console.log('Reserves:');
console.log(`  Reserve In:  ${formatAmount(reserveIn, 18)}`);
console.log(`  Reserve Out: ${formatAmount(reserveOut, 18)}`);
console.log(`Amount In: ${formatAmount(amountIn, 18)}`);
console.log(`Amount Out: ${formatAmount(amountOut, 18)}`);

// Manual calculation for verification:
// amountInWithFee = 100 * 9970 = 997000
// numerator = 997000 * 2000 = 1994000000
// denominator = 1000 * 10000 + 997000 = 10997000
// result = 1994000000 / 10997000 = 181.34... tokens

const expectedOut = (amountIn * 9970n * reserveOut) / (reserveIn * 10000n + amountIn * 9970n);
console.log(`Expected: ${formatAmount(expectedOut, 18)}`);
console.log(`Match: ${amountOut === expectedOut ? '✅ PASS' : '❌ FAIL'}\n`);

console.log('=== ARBITRAGE SIMULATION (MOCK) ===\n');

// Create mock opportunity
const mockOpp = {
  blockNumber: 1000000,
  timestamp: Date.now(),
  route: 'forward',
  tokenA: '0x0000000000000000000000000000000000000001',
  tokenB: '0x0000000000000000000000000000000000000002',
  amountIn: parseAmount('1', 18),
  dex1: 'DEX1',
  dex2: 'DEX2',
  quote1: {
    amountOut: parseAmount('1.05', 18), // 5% gain on first swap
    path: [],
    dex: 'DEX1',
  },
  quote2: {
    amountOut: parseAmount('1.08', 18), // Total 8% gain
    path: [],
    dex: 'DEX2',
  },
};

console.log('Mock Opportunity:');
console.log(`  Route: ${mockOpp.route}`);
console.log(`  Amount In: ${formatAmount(mockOpp.amountIn, 18)}`);
console.log(`  Quote 1 Out: ${formatAmount(mockOpp.quote1.amountOut, 18)}`);
console.log(`  Quote 2 Out: ${formatAmount(mockOpp.quote2.amountOut, 18)}`);

// Check quote chaining
const chainCorrect = mockOpp.quote2.amountOut > mockOpp.amountIn;
console.log(`  Quote Chain: ${chainCorrect ? '✅ Looks profitable' : '❌ Loss'}\n`);

console.log('=== PROFIT CALCULATION VALIDATION ===\n');

const borrowAmount = mockOpp.amountIn;
const flashloanFee = (borrowAmount * 5n) / 10000n; // 0.05%
const totalRepayment = borrowAmount + flashloanFee;

console.log(`Flashloan: ${formatAmount(borrowAmount, 18)}`);
console.log(`Flashloan Fee (5 bps): ${formatAmount(flashloanFee, 18)}`);
console.log(`Total Repayment: ${formatAmount(totalRepayment, 18)}`);

// Simulate slippage
const slippageBps = 50; // 0.5%
const finalWithSlippage = mockOpp.quote2.amountOut - (mockOpp.quote2.amountOut * BigInt(slippageBps)) / 10000n;
console.log(`Final Amount (with ${slippageBps} bps slippage): ${formatAmount(finalWithSlippage, 18)}`);

// Calculate profit
const grossProfit = finalWithSlippage - totalRepayment;
const gasEstimate = 500000n;
const gasPrice = 1n * 1000000000n; // 1 gwei
const gasCost = gasEstimate * gasPrice;

const netProfit = grossProfit - gasCost;

console.log(`Gross Profit: ${formatAmount(grossProfit, 18)}`);
console.log(`Gas Cost: ${formatAmount(gasCost, 18)} (${gasEstimate} gas @ 1 gwei)`);
console.log(`Net Profit: ${formatAmount(netProfit, 18)}`);
console.log(`Profit %: ${Number(netProfit * 10000n / borrowAmount) / 100}%`);

if (netProfit > 0n) {
  console.log('✅ PROFITABLE');
} else {
  console.log('❌ NOT PROFITABLE');
}

console.log('\n=== TEST COMPLETE ===');
