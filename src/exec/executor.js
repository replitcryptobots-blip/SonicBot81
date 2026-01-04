// ════════════════════════════════════════════════════════════
// Executor Module
// Builds and executes atomic arbitrage transactions
// ════════════════════════════════════════════════════════════

import { Contract } from 'ethers';
import { config } from '../config.js';
import { logger, logTrade } from '../logger.js';
import { formatAmount } from '../math.js';
import { FLASHLOAN_ARBITRAGE_ABI } from '../contracts/FlashloanArbitrageABI.js';

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
      const txResponse = await this.provider.sendRawTransaction(signedTx);

      // Extract txHash (sendRawTransaction returns the hash directly)
      txHash = txResponse;

      logger.info({ txHash }, 'Transaction broadcast');

      // Wait for confirmation (with configurable timeout)
      // CRITICAL FIX: Must poll for receipt, not just call getTransactionReceipt once
      const confirmationTimeout = config.performance.txConfirmationTimeout;
      receipt = await this.waitForReceipt(txHash, confirmationTimeout);

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
   * Uses the deployed FlashloanArbitrage contract
   */
  async buildTransaction(opportunity, simulation) {
    // Check if contract is configured
    const contractAddress = config.flashloan.receiverContract;

    if (!contractAddress) {
      throw new Error(
        'FLASHLOAN_RECEIVER_CONTRACT not configured. ' +
        'Deploy contracts/FlashloanArbitrage.sol and set the address in .env'
      );
    }

    // Create contract instance
    const arbContract = new Contract(
      contractAddress,
      FLASHLOAN_ARBITRAGE_ABI,
      this.wallet
    );

    // Prepare parameters
    const token0 = opportunity.tokenA;
    const token1 = opportunity.tokenB;
    const amount = opportunity.amountIn;
    const dex1Name = opportunity.dex1;
    const dex2Name = opportunity.dex2;
    const minIntermediate = BigInt(simulation.execution.minIntermediate);
    const minFinalAmount = BigInt(simulation.execution.minFinalAmount);
    const deadline = simulation.execution.deadline;

    // Build contract call
    // This calls executeArbitrage on the deployed contract
    const calldata = arbContract.interface.encodeFunctionData('executeArbitrage', [
      token0,
      token1,
      amount,
      dex1Name,
      dex2Name,
      minIntermediate,
      minFinalAmount,
      deadline
    ]);

    return {
      to: contractAddress,
      data: calldata,
      value: 0n,
    };
  }

  /**
   * Wait for transaction receipt with polling
   * Uses configurable timeout and poll interval from config
   * @param {string} txHash - Transaction hash
   * @param {number} timeoutMs - Timeout in milliseconds (default from config)
   * @returns {Promise<object>} - Transaction receipt
   */
  async waitForReceipt(txHash, timeoutMs) {
    const startTime = Date.now();
    const timeout = timeoutMs || config.performance.txConfirmationTimeout;
    const pollInterval = config.performance.txPollInterval;

    logger.debug({ txHash, timeout, pollInterval }, 'Waiting for transaction receipt');

    while (Date.now() - startTime < timeout) {
      try {
        const receipt = await this.provider.getTransactionReceipt(txHash);

        if (receipt) {
          // Receipt found - transaction mined
          const elapsed = Date.now() - startTime;
          logger.debug({ txHash, elapsed, blockNumber: receipt.blockNumber }, 'Receipt received');
          return receipt;
        }

        // Not mined yet, wait and retry
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (err) {
        logger.debug({ err, txHash }, 'Error fetching receipt');
        // Continue polling
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error(`Transaction receipt timeout after ${timeout}ms`);
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
