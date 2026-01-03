// ════════════════════════════════════════════════════════════
// Provider Module
// RPC provider with failover, timeouts, and rate limiting
// ════════════════════════════════════════════════════════════

import { JsonRpcProvider, WebSocketProvider, Wallet, FetchRequest } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Rate limiter
 */
class RateLimiter {
  constructor(maxPerSecond) {
    this.maxPerSecond = maxPerSecond;
    this.requests = [];
  }

  async acquire() {
    const now = Date.now();
    // Remove requests older than 1 second
    this.requests = this.requests.filter(time => now - time < 1000);

    if (this.requests.length >= this.maxPerSecond) {
      const oldestRequest = this.requests[0];
      const waitTime = 1000 - (now - oldestRequest);
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      return this.acquire(); // Retry
    }

    this.requests.push(now);
  }
}

/**
 * Timeout wrapper for RPC calls
 */
async function withTimeout(promise, timeoutMs, operation = 'RPC call') {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeout]);
}

/**
 * Exponential backoff with jitter
 */
function calculateBackoff(attempt, baseDelay = 1000, maxDelay = 10000) {
  const exponentialDelay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
  const jitter = Math.random() * 0.3 * exponentialDelay; // 30% jitter
  return exponentialDelay + jitter;
}

/**
 * RPC Provider with failover and resilience
 */
export class ResilientProvider {
  constructor(rpcUrls, wsUrl, timeout, maxRequestsPerSecond) {
    this.rpcUrls = rpcUrls;
    this.wsUrl = wsUrl;
    this.timeout = timeout;
    this.rateLimiter = new RateLimiter(maxRequestsPerSecond);

    this.currentProviderIndex = 0;
    this.providers = [];
    this.wsProvider = null;
    this.primaryProvider = null;

    this.initProviders();
  }

  initProviders() {
    // Create HTTP providers with custom fetch config
    this.providers = this.rpcUrls.map(url => {
      const fetchReq = new FetchRequest(url);
      fetchReq.timeout = this.timeout;
      return new JsonRpcProvider(fetchReq, null, { polling: true });
    });

    this.primaryProvider = this.providers[0];

    // Create WebSocket provider if available
    if (this.wsUrl) {
      try {
        this.wsProvider = new WebSocketProvider(this.wsUrl);
        logger.info('WebSocket provider initialized');
      } catch (err) {
        logger.warn({ err }, 'Failed to initialize WebSocket provider, will use polling');
      }
    }
  }

  /**
   * Get current active provider
   */
  getProvider() {
    return this.providers[this.currentProviderIndex];
  }

  /**
   * Get WebSocket provider or null
   */
  getWsProvider() {
    return this.wsProvider;
  }

  /**
   * Failover to next RPC endpoint
   */
  failover() {
    this.currentProviderIndex = (this.currentProviderIndex + 1) % this.providers.length;
    logger.warn(`Failing over to RPC #${this.currentProviderIndex}: ${this.rpcUrls[this.currentProviderIndex]}`);
  }

  /**
   * Execute RPC call with retry and failover
   */
  async call(method, params = [], maxRetries = 3) {
    await this.rateLimiter.acquire();

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const provider = this.getProvider();

      try {
        const result = await withTimeout(
          provider.send(method, params),
          this.timeout,
          method
        );

        return result;
      } catch (err) {
        logger.debug({ err, attempt, method }, 'RPC call failed');

        if (attempt < maxRetries - 1) {
          // Try failover
          this.failover();

          // Exponential backoff
          const delay = calculateBackoff(attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Get latest block number
   */
  async getBlockNumber() {
    const result = await this.call('eth_blockNumber');
    return parseInt(result, 16);
  }

  /**
   * Get block by number
   */
  async getBlock(blockNumber, includeTxs = false) {
    const blockParam = typeof blockNumber === 'number'
      ? `0x${blockNumber.toString(16)}`
      : blockNumber;

    return this.call('eth_getBlockByNumber', [blockParam, includeTxs]);
  }

  /**
   * Get transaction receipt
   */
  async getTransactionReceipt(txHash) {
    return this.call('eth_getTransactionReceipt', [txHash]);
  }

  /**
   * Get current gas price
   */
  async getGasPrice() {
    const result = await this.call('eth_gasPrice');
    return BigInt(result);
  }

  /**
   * Get fee data (EIP-1559)
   */
  async getFeeData() {
    try {
      const [baseFee, priorityFee] = await Promise.all([
        this.call('eth_getBlockByNumber', ['latest', false]).then(block =>
          block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : null
        ),
        this.call('eth_maxPriorityFeePerGas').then(fee => BigInt(fee)).catch(() => null),
      ]);

      if (baseFee && priorityFee) {
        return {
          maxFeePerGas: baseFee * 2n + priorityFee,
          maxPriorityFeePerGas: priorityFee,
        };
      }
    } catch (err) {
      logger.debug({ err }, 'EIP-1559 fee data not available, falling back to legacy');
    }

    // Fallback to legacy gas price
    const gasPrice = await this.getGasPrice();
    return {
      gasPrice,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
    };
  }

  /**
   * Estimate gas
   */
  async estimateGas(transaction) {
    const result = await this.call('eth_estimateGas', [transaction]);
    return BigInt(result);
  }

  /**
   * Get transaction count (nonce)
   */
  async getTransactionCount(address, blockTag = 'latest') {
    const result = await this.call('eth_getTransactionCount', [address, blockTag]);
    return parseInt(result, 16);
  }

  /**
   * Call contract (read-only)
   */
  async callContract(transaction, blockTag = 'latest') {
    return this.call('eth_call', [transaction, blockTag]);
  }

  /**
   * Send raw transaction
   */
  async sendRawTransaction(signedTx) {
    return this.call('eth_sendRawTransaction', [signedTx]);
  }

  /**
   * Get chain ID
   */
  async getChainId() {
    const result = await this.call('eth_chainId');
    return parseInt(result, 16);
  }

  /**
   * Get contract code
   */
  async getCode(address, blockTag = 'latest') {
    return this.call('eth_getCode', [address, blockTag]);
  }

  /**
   * Cleanup
   */
  async destroy() {
    if (this.wsProvider) {
      await this.wsProvider.destroy();
    }
    for (const provider of this.providers) {
      await provider.destroy();
    }
  }
}

/**
 * Create and initialize provider
 */
export async function createProvider() {
  const provider = new ResilientProvider(
    config.rpcUrls,
    config.wsRpcUrl,
    config.performance.rpcTimeout,
    config.performance.maxRequestsPerSecond
  );

  logger.info({
    rpcUrls: config.rpcUrls,
    hasWebSocket: !!config.wsRpcUrl
  }, 'Provider initialized');

  return provider;
}

/**
 * Create wallet from config
 */
export function createWallet(provider) {
  if (!config.privateKey) {
    throw new Error('PRIVATE_KEY not configured');
  }

  const privateKey = config.privateKey.startsWith('0x')
    ? config.privateKey
    : '0x' + config.privateKey;

  const wallet = new Wallet(privateKey, provider.getProvider());

  logger.info({ address: wallet.address }, 'Wallet initialized');

  return wallet;
}

export default { createProvider, createWallet, ResilientProvider };
