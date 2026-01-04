// ════════════════════════════════════════════════════════════
// Simulator Module
// Calculates profitability with ALL costs and validates trades
// ════════════════════════════════════════════════════════════

import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  applyBps,
  subtractBps,
  formatAmount,
  formatBps,
  isProfitSufficient,
  parseAmount,
} from '../math.js';

export class ArbSimulator {
  constructor(provider) {
    this.provider = provider;
    this.minNetProfit = parseAmount(config.profit.minNetProfit, 18);
    this.minNetProfitBps = config.profit.minNetProfitBps;
    this.maxSlippageBps = config.profit.maxSlippageBps;
    this.maxGasGwei = BigInt(config.profit.maxGasGwei) * 1000000000n; // Convert to wei
    this.flashloanFeeBps = config.flashloan.feeBps;

    logger.info({
      minNetProfit: config.profit.minNetProfit,
      minNetProfitBps: this.minNetProfitBps,
      maxSlippageBps: this.maxSlippageBps,
      flashloanFeeBps: this.flashloanFeeBps,
    }, 'Simulator initialized');
  }

  /**
   * Simulate arbitrage opportunity
   */
  async simulate(opportunity) {
    const startTime = Date.now();
    const reasons = [];

    try {
      // Step 1: Calculate swap outputs
      const { amountIn, quote1, quote2 } = opportunity;
      const intermediateAmount = quote1.amountOut;
      const finalAmount = quote2.amountOut;

      // Step 2: Apply slippage protection
      // Only apply to final amount (double slippage is too conservative)
      // Use tighter tolerance for intermediate to catch quote staleness
      const slippageBps = this.maxSlippageBps;
      const minIntermediate = subtractBps(intermediateAmount, Math.min(slippageBps, 20)); // Max 0.2% for intermediate
      const minFinalAmount = subtractBps(finalAmount, slippageBps);

      // Step 3: Calculate flashloan fee
      const flashloanFee = applyBps(amountIn, this.flashloanFeeBps);
      const totalRepayment = amountIn + flashloanFee;

      // Step 4: Estimate gas cost
      let gasCost = 0n;
      let gasEstimate = 0n;
      let gasPrice = 0n;

      try {
        const feeData = await this.provider.getFeeData();
        gasPrice = feeData.gasPrice || feeData.maxFeePerGas || 0n;

        // Estimate: flashloan + 2 swaps + approvals
        // Conservative: 500k gas
        gasEstimate = 500000n;
        gasCost = gasEstimate * gasPrice;
      } catch (err) {
        logger.debug({ err }, 'Gas estimation failed');
        reasons.push('Gas estimation failed');
      }

      // Step 5: Check gas price limit
      if (gasPrice > this.maxGasGwei) {
        reasons.push(
          `Gas price too high: ${formatAmount(gasPrice, 9)} gwei > ${formatAmount(this.maxGasGwei, 9)} gwei`
        );
      }

      // Step 6: Calculate net profit
      const grossProfit = minFinalAmount - totalRepayment;
      const netProfit = grossProfit - gasCost;

      // Step 7: Validate profitability
      const isProfitable = netProfit > 0n;
      const meetsThreshold = netProfit >= this.minNetProfit;
      const meetsRelativeThreshold = isProfitSufficient(
        netProfit,
        amountIn,
        this.minNetProfitBps
      );

      if (!isProfitable) {
        reasons.push(`Not profitable: net ${formatAmount(netProfit, 18)}`);
      }

      if (!meetsThreshold) {
        reasons.push(
          `Below minimum profit: ${formatAmount(netProfit, 18)} < ${formatAmount(this.minNetProfit, 18)}`
        );
      }

      if (!meetsRelativeThreshold) {
        reasons.push(
          `Below minimum profit %: ${formatBps(Number(netProfit * 10000n / amountIn))} < ${formatBps(this.minNetProfitBps)}`
        );
      }

      // Step 8: Build result
      const result = {
        decision: isProfitable && meetsThreshold && meetsRelativeThreshold && reasons.length === 0
          ? 'ACCEPT'
          : 'REJECT',
        reasons,
        metrics: {
          amountIn: amountIn.toString(),
          amountInFormatted: formatAmount(amountIn, 18),
          intermediateAmount: intermediateAmount.toString(),
          intermediateAmountFormatted: formatAmount(intermediateAmount, 18),
          finalAmount: finalAmount.toString(),
          finalAmountFormatted: formatAmount(finalAmount, 18),
          minFinalAmount: minFinalAmount.toString(),
          minFinalAmountFormatted: formatAmount(minFinalAmount, 18),
          flashloanFee: flashloanFee.toString(),
          flashloanFeeFormatted: formatAmount(flashloanFee, 18),
          totalRepayment: totalRepayment.toString(),
          totalRepaymentFormatted: formatAmount(totalRepayment, 18),
          gasEstimate: gasEstimate.toString(),
          gasPrice: gasPrice.toString(),
          gasPriceGwei: formatAmount(gasPrice, 9),
          gasCost: gasCost.toString(),
          gasCostFormatted: formatAmount(gasCost, 18),
          grossProfit: grossProfit.toString(),
          grossProfitFormatted: formatAmount(grossProfit, 18),
          netProfit: netProfit.toString(),
          netProfitFormatted: formatAmount(netProfit, 18),
          profitBps: Number(netProfit * 10000n / amountIn),
          profitPercent: formatBps(Number(netProfit * 10000n / amountIn)),
          slippageBps: slippageBps,
        },
        execution: {
          minIntermediate: minIntermediate.toString(),
          minFinalAmount: minFinalAmount.toString(),
          deadline: Math.floor(Date.now() / 1000) + 60, // 60 seconds (arbitrage must be fast)
          gasLimit: gasEstimate.toString(),
          gasPrice: gasPrice.toString(),
        },
        simulationTime: Date.now() - startTime,
      };

      // Log result
      if (result.decision === 'ACCEPT') {
        logger.info({
          opportunity: {
            route: opportunity.route,
            dex1: opportunity.dex1,
            dex2: opportunity.dex2,
          },
          metrics: {
            netProfit: result.metrics.netProfitFormatted,
            profitPercent: result.metrics.profitPercent,
          }
        }, '✓ PROFITABLE OPPORTUNITY');
      } else {
        logger.debug({
          reasons: result.reasons,
          netProfit: result.metrics.netProfitFormatted,
        }, '✗ Opportunity rejected');
      }

      return result;

    } catch (err) {
      logger.error({ err, opportunity }, 'Simulation error');
      return {
        decision: 'REJECT',
        reasons: [`Simulation error: ${err.message}`],
        metrics: {},
        execution: {},
        simulationTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Batch simulate multiple opportunities
   */
  async simulateMany(opportunities) {
    const results = [];

    for (const opportunity of opportunities) {
      const result = await this.simulate(opportunity);
      results.push({
        opportunity,
        simulation: result,
      });
    }

    // Sort by net profit descending
    results.sort((a, b) => {
      const profitA = BigInt(a.simulation.metrics.netProfit || '0');
      const profitB = BigInt(b.simulation.metrics.netProfit || '0');

      if (profitA > profitB) return -1;
      if (profitA < profitB) return 1;
      return 0;
    });

    return results;
  }

  /**
   * Get simulator stats
   */
  getStats() {
    return {
      minNetProfit: formatAmount(this.minNetProfit, 18),
      minNetProfitBps: this.minNetProfitBps,
      maxSlippageBps: this.maxSlippageBps,
      flashloanFeeBps: this.flashloanFeeBps,
    };
  }
}

export default ArbSimulator;
