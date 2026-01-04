// ════════════════════════════════════════════════════════════
// Math Utilities
// BigInt-safe decimal math (NO FLOATS for money calculations)
// ════════════════════════════════════════════════════════════

import { parseUnits, formatUnits } from 'ethers';

/**
 * Basis points helpers
 */
export const BPS_DIVISOR = 10000n;

/**
 * Apply basis points to a BigInt value
 * @param {bigint} value - The value to apply BPS to
 * @param {number} bps - Basis points (e.g., 50 = 0.5%)
 * @returns {bigint}
 */
export function applyBps(value, bps) {
  return (value * BigInt(bps)) / BPS_DIVISOR;
}

/**
 * Subtract basis points from a value
 * @param {bigint} value - The value
 * @param {number} bps - Basis points to subtract
 * @returns {bigint}
 */
export function subtractBps(value, bps) {
  return value - applyBps(value, bps);
}

/**
 * Add basis points to a value
 * @param {bigint} value - The value
 * @param {number} bps - Basis points to add
 * @returns {bigint}
 */
export function addBps(value, bps) {
  return value + applyBps(value, bps);
}

/**
 * Calculate percentage difference in basis points
 * @param {bigint} original - Original value
 * @param {bigint} final - Final value
 * @returns {bigint} - Difference in basis points
 */
export function calculateBpsDifference(original, final) {
  if (original === 0n) return 0n;
  const diff = final - original;
  return (diff * BPS_DIVISOR) / original;
}

/**
 * Parse token amount to BigInt
 * @param {string} amount - Human-readable amount
 * @param {number} decimals - Token decimals
 * @returns {bigint}
 */
export function parseAmount(amount, decimals = 18) {
  return parseUnits(amount, decimals);
}

/**
 * Format BigInt to human-readable string
 * @param {bigint} amount - BigInt amount
 * @param {number} decimals - Token decimals
 * @returns {string}
 */
export function formatAmount(amount, decimals = 18) {
  return formatUnits(amount, decimals);
}

/**
 * Calculate output amount after fee
 * @param {bigint} amountIn - Input amount
 * @param {number} feeBps - Fee in basis points
 * @returns {bigint}
 */
export function amountAfterFee(amountIn, feeBps) {
  return subtractBps(amountIn, feeBps);
}

/**
 * Calculate minimum amount out with slippage
 * @param {bigint} amountOut - Expected output
 * @param {number} slippageBps - Slippage tolerance in BPS
 * @returns {bigint}
 */
export function minAmountOut(amountOut, slippageBps) {
  return subtractBps(amountOut, slippageBps);
}

/**
 * Calculate swap output using constant product formula (x * y = k)
 * UniswapV2-compatible: (amountIn * (10000 - fee) * reserveOut) / (reserveIn * 10000 + amountIn * (10000 - fee))
 * @param {bigint} amountIn - Amount of token A
 * @param {bigint} reserveIn - Reserve of token A
 * @param {bigint} reserveOut - Reserve of token B
 * @param {number} feeBps - Pool fee in basis points
 * @returns {bigint} - Amount of token B out
 */
export function getAmountOut(amountIn, reserveIn, reserveOut, feeBps = 30) {
  if (amountIn === 0n || reserveIn === 0n || reserveOut === 0n) {
    return 0n;
  }

  // Fee multiplier: 10000 - feeBps (e.g., 9970 for 30 bps = 0.3%)
  const feeMultiplier = BPS_DIVISOR - BigInt(feeBps);

  // amountIn with fee applied
  const amountInWithFee = amountIn * feeMultiplier;

  // numerator = amountInWithFee * reserveOut
  const numerator = amountInWithFee * reserveOut;

  // denominator = reserveIn * 10000 + amountInWithFee
  const denominator = reserveIn * BPS_DIVISOR + amountInWithFee;

  return numerator / denominator;
}

/**
 * Calculate input needed for desired output (constant product)
 * UniswapV2-compatible: (reserveIn * amountOut * 10000) / ((reserveOut - amountOut) * (10000 - fee)) + 1
 * @param {bigint} amountOut - Desired output
 * @param {bigint} reserveIn - Reserve of token A
 * @param {bigint} reserveOut - Reserve of token B
 * @param {number} feeBps - Pool fee in basis points
 * @returns {bigint} - Amount of token A needed
 */
export function getAmountIn(amountOut, reserveIn, reserveOut, feeBps = 30) {
  if (amountOut === 0n || reserveIn === 0n || reserveOut === 0n) {
    return 0n;
  }

  if (amountOut >= reserveOut) {
    throw new Error('Insufficient reserves for desired output');
  }

  const feeMultiplier = BPS_DIVISOR - BigInt(feeBps);

  const numerator = reserveIn * amountOut * BPS_DIVISOR;
  const denominator = (reserveOut - amountOut) * feeMultiplier;

  // Add 1 to round up
  return numerator / denominator + 1n;
}

/**
 * Safe BigInt max
 */
export function max(a, b) {
  return a > b ? a : b;
}

/**
 * Safe BigInt min
 */
export function min(a, b) {
  return a < b ? a : b;
}

/**
 * Check if profit meets threshold
 * @param {bigint} profit - Net profit
 * @param {bigint} investment - Initial investment
 * @param {number} minProfitBps - Minimum profit in BPS
 * @returns {boolean}
 */
export function isProfitSufficient(profit, investment, minProfitBps) {
  if (profit <= 0n) return false;
  const profitBps = calculateBpsDifference(investment, investment + profit);
  return profitBps >= BigInt(minProfitBps);
}

/**
 * Format BPS as percentage string
 * @param {bigint|number} bps - Basis points
 * @returns {string}
 */
export function formatBps(bps) {
  const value = typeof bps === 'bigint' ? Number(bps) : bps;
  return (value / 100).toFixed(2) + '%';
}

/**
 * Safe division with rounding down
 * @param {bigint} numerator
 * @param {bigint} denominator
 * @returns {bigint}
 */
export function divDown(numerator, denominator) {
  if (denominator === 0n) return 0n;
  return numerator / denominator;
}

/**
 * Safe division with rounding up
 * @param {bigint} numerator
 * @param {bigint} denominator
 * @returns {bigint}
 */
export function divUp(numerator, denominator) {
  if (denominator === 0n) return 0n;
  return (numerator + denominator - 1n) / denominator;
}

/**
 * Check if value is within bounds
 * @param {bigint} value
 * @param {bigint} minVal
 * @param {bigint} maxVal
 * @returns {boolean}
 */
export function isWithinBounds(value, minVal, maxVal) {
  return value >= minVal && value <= maxVal;
}
