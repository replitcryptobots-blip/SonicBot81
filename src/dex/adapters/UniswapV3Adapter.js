// ════════════════════════════════════════════════════════════
// UniswapV3 Adapter
// V3-style with QuoterV2 for quotes and SwapRouter02 for execution
// Compatible with: Wagmi, Uniswap V3, etc.
// ════════════════════════════════════════════════════════════

import { Contract, Interface, solidityPacked } from 'ethers';
import { logger } from '../../logger.js';

// QuoterV2 ABI - for quoting swaps
const QUOTER_V2_ABI = [
  // Single hop quote
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  // Multi-hop quote
  'function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut, uint160[] memory sqrtPriceX96AfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)',
];

// SwapRouter02 ABI - for executing swaps
const SWAP_ROUTER_02_ABI = [
  // Single hop swap
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  // Multi-hop swap
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)',
  // Multicall for batching
  'function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory results)',
];

// V3 Factory ABI - for verifying pools exist
const V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

// Common fee tiers in V3 (in hundredths of a bip, i.e., 1/100 of 1 basis point)
const DEFAULT_FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

export class UniswapV3Adapter {
  constructor(name, config, provider) {
    this.name = name;
    this.type = 'uniswap_v3';
    this.chainId = config.chainId;
    this.routerAddress = config.router; // SwapRouter02
    this.quoterAddress = config.quoter; // QuoterV2
    this.factoryAddress = config.factory || null;
    this.feeBps = config.feeBps || 30; // Default DEX fee (for display)
    this.defaultFeeTier = config.defaultFeeTier || 3000; // 0.3%
    this.feeTiers = config.feeTiers || DEFAULT_FEE_TIERS;
    this.provider = provider;
    this.quoteSupported = !!this.quoterAddress;

    // Create contract instances
    if (this.routerAddress) {
      this.router = new Contract(
        this.routerAddress,
        SWAP_ROUTER_02_ABI,
        provider.getProvider()
      );
    }

    if (this.quoterAddress) {
      this.quoter = new Contract(
        this.quoterAddress,
        QUOTER_V2_ABI,
        provider.getProvider()
      );
    }

    if (this.factoryAddress) {
      this.factory = new Contract(
        this.factoryAddress,
        V3_FACTORY_ABI,
        provider.getProvider()
      );
    }

    logger.debug({
      name: this.name,
      type: this.type,
      router: this.routerAddress,
      quoter: this.quoterAddress,
      factory: this.factoryAddress,
      defaultFeeTier: this.defaultFeeTier,
      feeTiers: this.feeTiers,
    }, 'UniswapV3Adapter initialized');
  }

  /**
   * Encode V3 path for multi-hop swaps
   * Path format: tokenIn + fee + tokenOut (+ fee + tokenOut ...)
   * @param {string[]} tokens - Array of token addresses
   * @param {number[]} fees - Array of fee tiers between tokens
   * @returns {string} Encoded path
   */
  encodePath(tokens, fees) {
    if (tokens.length !== fees.length + 1) {
      throw new Error('Invalid path: tokens length should be fees length + 1');
    }

    let path = tokens[0];
    for (let i = 0; i < fees.length; i++) {
      path = solidityPacked(
        ['bytes', 'uint24', 'address'],
        [path, fees[i], tokens[i + 1]]
      );
    }
    return path;
  }

  /**
   * Get quote for exact input single hop swap
   * Tries multiple fee tiers to find best quote
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {bigint} amountIn - Input amount
   * @param {number} [feeTier] - Specific fee tier (optional)
   * @returns {Promise<{amountOut: bigint, path: string[], dex: string, feeTier: number}>}
   */
  async getQuote(tokenIn, tokenOut, amountIn, feeTier = null) {
    if (!this.quoter) {
      throw new Error(`${this.name}: Quoter not configured - quoting not supported`);
    }

    // If specific fee tier provided, use it directly
    if (feeTier) {
      return this._getQuoteSingleTier(tokenIn, tokenOut, amountIn, feeTier);
    }

    // Try all fee tiers and return best quote
    let bestQuote = null;
    const errors = [];

    for (const tier of this.feeTiers) {
      try {
        const quote = await this._getQuoteSingleTier(tokenIn, tokenOut, amountIn, tier);

        if (!bestQuote || quote.amountOut > bestQuote.amountOut) {
          bestQuote = quote;
        }
      } catch (err) {
        errors.push({ tier, error: err.message });
      }
    }

    if (!bestQuote) {
      const msg = errors.map(e => `${e.tier}: ${e.error}`).join(', ');
      throw new Error(`${this.name}: No valid quotes found. Errors: ${msg}`);
    }

    return bestQuote;
  }

  /**
   * Get quote for a specific fee tier
   * @private
   */
  async _getQuoteSingleTier(tokenIn, tokenOut, amountIn, feeTier) {
    try {
      // QuoterV2.quoteExactInputSingle uses a struct parameter
      const params = {
        tokenIn,
        tokenOut,
        amountIn,
        fee: feeTier,
        sqrtPriceLimitX96: 0n, // No price limit
      };

      // QuoterV2 is a view function that reverts with the quote data
      // We need to use staticCall to get the return values
      const result = await this.quoter.quoteExactInputSingle.staticCall(params);

      return {
        amountOut: result[0], // amountOut
        path: [tokenIn, tokenOut],
        dex: this.name,
        type: this.type,
        feeTier,
        gasEstimate: result[3], // gasEstimate from quoter
      };
    } catch (err) {
      const msg = err.message || '';
      // Parse common revert reasons
      if (msg.includes('SPL') || msg.includes('Swap amount too small')) {
        throw new Error('Amount too small for pool');
      }
      if (msg.includes('LO') || msg.includes('insufficient liquidity')) {
        throw new Error('Insufficient liquidity');
      }
      throw err;
    }
  }

  /**
   * Get quote for multi-hop path
   * @param {bigint} amountIn - Input amount
   * @param {string[]} tokens - Token path
   * @param {number[]} fees - Fee tiers for each hop
   * @returns {Promise<{amountOut: bigint, path: string[], dex: string}>}
   */
  async getQuoteMultiHop(amountIn, tokens, fees) {
    if (!this.quoter) {
      throw new Error(`${this.name}: Quoter not configured`);
    }

    if (tokens.length < 2) {
      throw new Error('Path must have at least 2 tokens');
    }

    // Use default fee tier if not provided
    const feeArray = fees || Array(tokens.length - 1).fill(this.defaultFeeTier);

    try {
      const encodedPath = this.encodePath(tokens, feeArray);

      const result = await this.quoter.quoteExactInput.staticCall(encodedPath, amountIn);

      return {
        amountOut: result[0],
        path: tokens,
        feeTiers: feeArray,
        dex: this.name,
        type: this.type,
        gasEstimate: result[3],
      };
    } catch (err) {
      logger.debug({ err: err.message, dex: this.name, tokens }, 'Multi-hop quote failed');
      throw err;
    }
  }

  /**
   * Build swap calldata for single hop exact input swap
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {bigint} amountIn - Input amount
   * @param {bigint} minAmountOut - Minimum output (slippage protection)
   * @param {string} recipient - Recipient address
   * @param {number} deadline - Unix timestamp deadline (not used in SwapRouter02 exactInputSingle)
   * @param {number} [feeTier] - Fee tier (defaults to defaultFeeTier)
   * @returns {{to: string, data: string, value: bigint}}
   */
  buildSwapCalldata(tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline, feeTier = null) {
    if (!this.router) {
      throw new Error(`${this.name}: Router not configured`);
    }

    const routerInterface = new Interface(SWAP_ROUTER_02_ABI);

    // exactInputSingle params
    const params = {
      tokenIn,
      tokenOut,
      fee: feeTier || this.defaultFeeTier,
      recipient,
      amountIn,
      amountOutMinimum: minAmountOut,
      sqrtPriceLimitX96: 0n, // No price limit
    };

    const calldata = routerInterface.encodeFunctionData('exactInputSingle', [params]);

    return {
      to: this.routerAddress,
      data: calldata,
      value: 0n,
    };
  }

  /**
   * Build swap calldata for multi-hop exact input swap
   * @param {string[]} tokens - Token path
   * @param {number[]} fees - Fee tiers for each hop
   * @param {bigint} amountIn - Input amount
   * @param {bigint} minAmountOut - Minimum output
   * @param {string} recipient - Recipient address
   * @param {number} deadline - Unix timestamp deadline
   * @returns {{to: string, data: string, value: bigint}}
   */
  buildSwapCalldataMultiHop(tokens, fees, amountIn, minAmountOut, recipient, deadline) {
    if (!this.router) {
      throw new Error(`${this.name}: Router not configured`);
    }

    const routerInterface = new Interface(SWAP_ROUTER_02_ABI);
    const encodedPath = this.encodePath(tokens, fees || Array(tokens.length - 1).fill(this.defaultFeeTier));

    const params = {
      path: encodedPath,
      recipient,
      amountIn,
      amountOutMinimum: minAmountOut,
    };

    const calldata = routerInterface.encodeFunctionData('exactInput', [params]);

    return {
      to: this.routerAddress,
      data: calldata,
      value: 0n,
    };
  }

  /**
   * Build multicall with deadline wrapper
   * Useful for batching multiple swaps atomically
   * @param {number} deadline - Unix timestamp deadline
   * @param {string[]} calldatas - Array of encoded function calls
   * @returns {{to: string, data: string, value: bigint}}
   */
  buildMulticall(deadline, calldatas) {
    if (!this.router) {
      throw new Error(`${this.name}: Router not configured`);
    }

    const routerInterface = new Interface(SWAP_ROUTER_02_ABI);
    const calldata = routerInterface.encodeFunctionData('multicall', [deadline, calldatas]);

    return {
      to: this.routerAddress,
      data: calldata,
      value: 0n,
    };
  }

  /**
   * Check if a pool exists for given tokens and fee tier
   * @param {string} tokenA - First token
   * @param {string} tokenB - Second token
   * @param {number} feeTier - Fee tier
   * @returns {Promise<string|null>} Pool address or null
   */
  async getPool(tokenA, tokenB, feeTier) {
    if (!this.factory) {
      return null;
    }

    try {
      const pool = await this.factory.getPool(tokenA, tokenB, feeTier);
      if (pool === '0x0000000000000000000000000000000000000000') {
        return null;
      }
      return pool;
    } catch (err) {
      logger.debug({ err: err.message, tokenA, tokenB, feeTier }, 'Pool lookup failed');
      return null;
    }
  }

  /**
   * Find best fee tier for a token pair
   * @param {string} tokenA - First token
   * @param {string} tokenB - Second token
   * @returns {Promise<number|null>} Best fee tier or null
   */
  async findBestFeeTier(tokenA, tokenB) {
    if (!this.factory) {
      return this.defaultFeeTier;
    }

    for (const tier of this.feeTiers) {
      const pool = await this.getPool(tokenA, tokenB, tier);
      if (pool) {
        return tier;
      }
    }

    return null;
  }

  /**
   * Verify contracts exist on-chain
   * @param {object} provider - RPC provider
   * @returns {Promise<boolean>}
   */
  async verify(provider) {
    const checks = [];

    if (this.routerAddress) {
      checks.push(
        provider.getCode(this.routerAddress).then(code => {
          if (!code || code === '0x') {
            throw new Error(`${this.name} router (SwapRouter02) has no code at ${this.routerAddress}`);
          }
          logger.debug(`${this.name} router verified`);
        })
      );
    }

    if (this.quoterAddress) {
      checks.push(
        provider.getCode(this.quoterAddress).then(code => {
          if (!code || code === '0x') {
            throw new Error(`${this.name} quoter (QuoterV2) has no code at ${this.quoterAddress}`);
          }
          logger.debug(`${this.name} quoter verified`);
        })
      );
    }

    if (this.factoryAddress) {
      checks.push(
        provider.getCode(this.factoryAddress).then(code => {
          if (!code || code === '0x') {
            throw new Error(`${this.name} factory has no code at ${this.factoryAddress}`);
          }
          logger.debug(`${this.name} factory verified`);
        })
      );
    }

    await Promise.all(checks);
    logger.info(`${this.name} (V3) verification passed`);
    return true;
  }

  /**
   * Get adapter info for display
   */
  getInfo() {
    return {
      name: this.name,
      type: this.type,
      router: this.routerAddress,
      quoter: this.quoterAddress,
      factory: this.factoryAddress,
      feeBps: this.feeBps,
      defaultFeeTier: this.defaultFeeTier,
      feeTiers: this.feeTiers,
      chainId: this.chainId,
      quoteSupported: this.quoteSupported,
    };
  }
}

export default UniswapV3Adapter;
