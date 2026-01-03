// ════════════════════════════════════════════════════════════
// Executor Module
// Builds and executes atomic arbitrage transactions
// ════════════════════════════════════════════════════════════

import { config } from '../config.js';
import { logger, logTrade } from '../logger.js';
import { formatAmount } from '../math.js';

/**
 * Circuit Breaker
 * Stops execution after consecutive failures
 */
class CircuitBreaker {
  constructor(maxFailures, cooldownSeconds) {
    this.maxFailures = maxFailures;
    this.cooldownSeconds = cooldownSeconds;
    this.consecutiveFailures = 0;
    this.isOpen = false;
    this.openedAt = null;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.isOpen = false;
    this.openedAt = null;
  }

  recordFailure() {
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.maxFailures) {
      this.isOpen = true;
      this.openedAt = Date.now();

      logger.error({
        consecutiveFailures: this.consecutiveFailures,
        cooldownSeconds: this.cooldownSeconds,
      }, 'CIRCUIT BREAKER OPENED - Trading halted');
    }
  }

  canExecute() {
    if (!this.isOpen) return true;

    const now = Date.now();
    const cooldownMs = this.cooldownSeconds * 1000;

    if (now - this.openedAt >= cooldownMs) {
      logger.info('Circuit breaker cooldown complete - resetting');
      this.reset();
      return true;
    }

    return false;
  }

  reset() {
    this.consecutiveFailures = 0;
    this.isOpen = false;
    this.openedAt = null;
  }

  getStatus() {
    return {
      isOpen: this.isOpen,
      consecutiveFailures: this.consecutiveFailures,
      maxFailures: this.maxFailures,
      openedAt: this.openedAt,
      cooldownSeconds: this.cooldownSeconds,
    };
  }
}

/**
 * Arbitrage Executor
 */
export class ArbExecutor {
  constructor(provider, wallet, dexRegistry, flashloanProvider) {
    this.provider = provider;
    this.wallet = wallet;
    this.dexRegistry = dexRegistry;
    this.flashloanProvider = flashloanProvider;

    this.circuitBreaker = new CircuitBreaker(
      config.circuitBreaker.maxConsecutiveFailures,
      config.circuitBreaker.cooldownSeconds
    );

    this.executionCount = 0;
    this.successCount = 0;
    this.failureCount = 0;

    logger.info({
      dryRun: config.dryRun,
      liveMode: config.liveMode,
      walletAddress: wallet.address,
    }, 'Executor initialized');
  }

  /**
   * Execute arbitrage opportunity
   */
  async execute(opportunity, simulation) {
    // Safety checks
    if (config.killSwitch) {
      logger.error('KILL SWITCH ACTIVATED - Execution aborted');
      return { success: false, reason: 'KILL_SWITCH' };
    }

    if (!this.circuitBreaker.canExecute()) {
      logger.warn('Circuit breaker is open - execution skipped');
      return { success: false, reason: 'CIRCUIT_BREAKER_OPEN' };
    }

    if (simulation.decision !== 'ACCEPT') {
      logger.debug('Simulation rejected - execution skipped');
      return { success: false, reason: 'SIMULATION_REJECTED' };
    }

    this.executionCount++;

    // DRY RUN mode - simulate only
    if (config.dryRun || !config.liveMode) {
      return await this.executeDryRun(opportunity, simulation);
    }

    // LIVE MODE - real execution
    return await this.executeLive(opportunity, simulation);
  }

  /**
   * Dry run execution (no real transaction)
   */
  async executeDryRun(opportunity, simulation) {
    logger.info('═══════════════════════════════════════════════════════');
    logger.info('  DRY RUN - No real transaction will be sent');
    logger.info('═══════════════════════════════════════════════════════');

    logger.info({
      opportunity: {
        route: opportunity.route,
        tokenA: opportunity.tokenA,
        tokenB: opportunity.tokenB,
        dex1: opportunity.dex1,
        dex2: opportunity.dex2,
        amountIn: formatAmount(opportunity.amountIn, 18),
      },
      simulation: {
        netProfit: simulation.metrics.netProfitFormatted,
        profitPercent: simulation.metrics.profitPercent,
        gasCost: simulation.metrics.gasCostFormatted,
      },
    }, 'Would execute arbitrage');

    // Log to trades file
    await logTrade({
      type: 'DRY_RUN',
      opportunity,
      simulation,
      result: 'SIMULATED',
    });

    this.circuitBreaker.recordSuccess();
    this.successCount++;

    return {
      success: true,
      reason: 'DRY_RUN',
      txHash: null,
    };
  }

  /**
   * Live execution (real transaction)
   */
  async executeLive(opportunity, simulation) {
    logger.warn('═══════════════════════════════════════════════════════');
    logger.warn('  LIVE MODE - Real transaction will be broadcast');
    logger.warn('═══════════════════════════════════════════════════════');

    const startTime = Date.now();
    let txHash = null;
    let receipt = null;

    try {
      // Build transaction
      const tx = await this.buildTransaction(opportunity, simulation);

      logger.info({ tx }, 'Transaction built');

      // Get nonce
      const nonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');

      // Build full transaction
      const fullTx = {
        ...tx,
        nonce,
        chainId: config.chainId,
        gasLimit: simulation.execution.gasLimit,
      };

      // Add gas price (EIP-1559 or legacy)
      if (simulation.execution.maxFeePerGas) {
        fullTx.maxFeePerGas = simulation.execution.maxFeePerGas;
        fullTx.maxPriorityFeePerGas = simulation.execution.maxPriorityFeePerGas;
      } else {
        fullTx.gasPrice = simulation.execution.gasPrice;
      }

      // Sign transaction
      const signedTx = await this.wallet.signTransaction(fullTx);

      logger.info('Transaction signed, broadcasting...');

      // Broadcast
      txHash = await this.provider.sendRawTransaction(signedTx);

      logger.info({ txHash }, 'Transaction broadcast');

      // Wait for confirmation (with timeout)
      const confirmationTimeout = 60000; // 60 seconds
      receipt = await Promise.race([
        this.provider.getTransactionReceipt(txHash),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Confirmation timeout')), confirmationTimeout)
        ),
      ]);

      // Check if transaction succeeded
      const success = receipt && receipt.status === 1;

      if (success) {
        logger.info({
          txHash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed?.toString(),
        }, '✓ Transaction confirmed');

        this.circuitBreaker.recordSuccess();
        this.successCount++;

        await logTrade({
          type: 'LIVE',
          opportunity,
          simulation,
          result: 'SUCCESS',
          txHash,
          receipt,
          executionTime: Date.now() - startTime,
        });

        return {
          success: true,
          reason: 'EXECUTED',
          txHash,
          receipt,
        };
      } else {
        logger.error({
          txHash,
          receipt,
        }, '✗ Transaction failed (reverted)');

        this.circuitBreaker.recordFailure();
        this.failureCount++;

        await logTrade({
          type: 'LIVE',
          opportunity,
          simulation,
          result: 'REVERTED',
          txHash,
          receipt,
          executionTime: Date.now() - startTime,
        });

        return {
          success: false,
          reason: 'REVERTED',
          txHash,
          receipt,
        };
      }

    } catch (err) {
      logger.error({ err, txHash }, 'Execution error');

      this.circuitBreaker.recordFailure();
      this.failureCount++;

      await logTrade({
        type: 'LIVE',
        opportunity,
        simulation,
        result: 'ERROR',
        error: err.message,
        txHash,
        executionTime: Date.now() - startTime,
      });

      return {
        success: false,
        reason: 'ERROR',
        error: err.message,
        txHash,
      };
    }
  }

  /**
   * Build atomic transaction
   * NOTE: This builds a DIRECT flashloan call.
   * In production, you need a CONTRACT that:
   * 1. Receives the flashloan
   * 2. Executes swaps
   * 3. Repays the loan
   * 4. Sends profit to your wallet
   */
  async buildTransaction(opportunity, simulation) {
    if (!this.flashloanProvider) {
      throw new Error('Flashloan provider not configured');
    }

    // WARNING: This is a simplified example
    // You MUST deploy a flashloan receiver contract that implements the full logic
    // See VERIFICATION_CHECKLIST.md for details

    logger.warn('═══════════════════════════════════════════════════════');
    logger.warn('  WARNING: You need a flashloan receiver contract!');
    logger.warn('  This is a placeholder - deploy your own contract.');
    logger.warn('═══════════════════════════════════════════════════════');

    const tokens = [opportunity.tokenA];
    const amounts = [opportunity.amountIn];

    // Encode the arbitrage parameters as userData
    const userData = this.encodeArbParams(opportunity, simulation);

    // Build flashloan call
    // NOTE: Replace receiverAddress with your deployed contract!
    const receiverAddress = this.wallet.address; // PLACEHOLDER

    const flashloanCall = this.flashloanProvider.buildFlashloanCall(
      receiverAddress,
      tokens,
      amounts,
      userData
    );

    return flashloanCall;
  }

  /**
   * Encode arbitrage parameters for flashloan receiver
   */
  encodeArbParams(opportunity, simulation) {
    // This is protocol-specific
    // Your receiver contract should decode this and execute the arbitrage

    const params = {
      route: opportunity.route,
      tokenA: opportunity.tokenA,
      tokenB: opportunity.tokenB,
      dex1: opportunity.dex1,
      dex2: opportunity.dex2,
      minIntermediate: simulation.execution.minIntermediate,
      minFinalAmount: simulation.execution.minFinalAmount,
      deadline: simulation.execution.deadline,
    };

    // Simple encoding - replace with proper ABI encoding for your contract
    return Buffer.from(JSON.stringify(params)).toString('hex');
  }

  /**
   * Get executor stats
   */
  getStats() {
    return {
      executionCount: this.executionCount,
      successCount: this.successCount,
      failureCount: this.failureCount,
      successRate: this.executionCount > 0
        ? (this.successCount / this.executionCount * 100).toFixed(2) + '%'
        : '0%',
      circuitBreaker: this.circuitBreaker.getStatus(),
    };
  }

  /**
   * Reset circuit breaker manually
   */
  resetCircuitBreaker() {
    this.circuitBreaker.reset();
    logger.info('Circuit breaker manually reset');
  }
}

export default ArbExecutor;
