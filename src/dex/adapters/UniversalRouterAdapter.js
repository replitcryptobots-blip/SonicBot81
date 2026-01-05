// ════════════════════════════════════════════════════════════
// Universal Router Adapter
// For Universal Router pattern (SpookySwap, Shadow Exchange, etc.)
// Uses a Quoter for quotes when available
// ════════════════════════════════════════════════════════════

import { Contract, Interface, solidityPacked, AbiCoder } from 'ethers';
import { logger } from '../../logger.js';

// Universal Router command types (from Uniswap Universal Router)
const Commands = {
  V3_SWAP_EXACT_IN: 0x00,
  V3_SWAP_EXACT_OUT: 0x01,
  PERMIT2_TRANSFER_FROM: 0x02,
  PERMIT2_PERMIT_BATCH: 0x03,
  SWEEP: 0x04,
  TRANSFER: 0x05,
  PAY_PORTION: 0x06,
  V2_SWAP_EXACT_IN: 0x08,
  V2_SWAP_EXACT_OUT: 0x09,
  PERMIT2_PERMIT: 0x0a,
  WRAP_ETH: 0x0b,
  UNWRAP_WETH: 0x0c,
  PERMIT2_TRANSFER_FROM_BATCH: 0x0d,
};

// Universal Router ABI (minimal)
const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable',
  'function execute(bytes calldata commands, bytes[] calldata inputs) external payable',
];

// Quoter ABI - most Universal Routers have a compatible quoter
// This is similar to QuoterV2 but may vary by implementation
const QUOTER_ABI = [
  // V3-style quote
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  'function quoteExactInput(bytes memory path, uint256 amountIn) external returns (uint256 amountOut, uint160[] memory sqrtPriceX96AfterList, uint32[] memory initializedTicksCrossedList, uint256 gasEstimate)',
  // V2-style quote (some quoters support both)
  'function getAmountsOut(uint256 amountIn, address[] memory path) external view returns (uint256[] memory amounts)',
];

// Default V3 fee tiers
const DEFAULT_FEE_TIERS = [500, 3000, 10000];

export class UniversalRouterAdapter {
  constructor(name, config, provider) {
    this.name = name;
    this.type = 'universal_router';
    this.chainId = config.chainId;
    this.routerAddress = config.router;
    this.quoterAddress = config.quoter || null;
    this.feeBps = config.feeBps || 30;
    this.defaultFeeTier = config.defaultFeeTier || 3000;
    this.feeTiers = config.feeTiers || DEFAULT_FEE_TIERS;
    this.provider = provider;

    // Quote support depends on having a quoter configured
    this.quoteSupported = !!this.quoterAddress;
    this.v2QuoteSupported = false; // Will be detected during verification
    this.v3QuoteSupported = false;

    // Create contract instances
    if (this.routerAddress) {
      this.router = new Contract(
        this.routerAddress,
        UNIVERSAL_ROUTER_ABI,
        provider.getProvider()
      );
    }

    if (this.quoterAddress) {
      this.quoter = new Contract(
        this.quoterAddress,
        QUOTER_ABI,
        provider.getProvider()
      );
    }

    logger.debug({
      name: this.name,
      type: this.type,
      router: this.routerAddress,
      quoter: this.quoterAddress,
      quoteSupported: this.quoteSupported,
    }, 'UniversalRouterAdapter initialized');
  }

  /**
   * Encode V3 path for multi-hop swaps
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
   * Get quote for exact input swap
   * Tries V3-style first, then V2-style if available
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {bigint} amountIn - Input amount
   * @param {number} [feeTier] - Fee tier for V3 pools (optional)
   * @returns {Promise<{amountOut: bigint, path: string[], dex: string}>}
   */
  async getQuote(tokenIn, tokenOut, amountIn, feeTier = null) {
    if (!this.quoter) {
      throw new Error(`${this.name}: Quoter not configured - quoting not supported. This DEX is excluded from scanning.`);
    }

    // Try V3-style quoting first
    if (this.v3QuoteSupported !== false) {
      try {
        return await this._getQuoteV3(tokenIn, tokenOut, amountIn, feeTier);
      } catch (err) {
        logger.debug({ dex: this.name, err: err.message }, 'V3 quote failed, trying V2');
      }
    }

    // Try V2-style quoting
    if (this.v2QuoteSupported !== false) {
      try {
        return await this._getQuoteV2(tokenIn, tokenOut, amountIn);
      } catch (err) {
        logger.debug({ dex: this.name, err: err.message }, 'V2 quote failed');
      }
    }

    throw new Error(`${this.name}: No quote method available`);
  }

  /**
   * Get V3-style quote (tries multiple fee tiers)
   * @private
   */
  async _getQuoteV3(tokenIn, tokenOut, amountIn, feeTier = null) {
    const tiersToTry = feeTier ? [feeTier] : this.feeTiers;
    let bestQuote = null;

    for (const tier of tiersToTry) {
      try {
        const params = {
          tokenIn,
          tokenOut,
          amountIn,
          fee: tier,
          sqrtPriceLimitX96: 0n,
        };

        const result = await this.quoter.quoteExactInputSingle.staticCall(params);

        const quote = {
          amountOut: result[0],
          path: [tokenIn, tokenOut],
          dex: this.name,
          type: this.type,
          feeTier: tier,
          gasEstimate: result[3],
          quoteMethod: 'v3',
        };

        if (!bestQuote || quote.amountOut > bestQuote.amountOut) {
          bestQuote = quote;
        }

        this.v3QuoteSupported = true;
      } catch (err) {
        // Continue to next tier
      }
    }

    if (!bestQuote) {
      throw new Error('No V3 pools found');
    }

    return bestQuote;
  }

  /**
   * Get V2-style quote
   * @private
   */
  async _getQuoteV2(tokenIn, tokenOut, amountIn) {
    try {
      const path = [tokenIn, tokenOut];
      const amounts = await this.quoter.getAmountsOut(amountIn, path);

      this.v2QuoteSupported = true;

      return {
        amountOut: amounts[1],
        path,
        dex: this.name,
        type: this.type,
        feeTier: null,
        quoteMethod: 'v2',
      };
    } catch (err) {
      this.v2QuoteSupported = false;
      throw err;
    }
  }

  /**
   * Get quote for multi-hop path
   * @param {bigint} amountIn - Input amount
   * @param {string[]} tokens - Token path
   * @param {number[]} [fees] - Fee tiers for V3 (optional)
   * @returns {Promise<{amountOut: bigint, path: string[], dex: string}>}
   */
  async getQuoteMultiHop(amountIn, tokens, fees = null) {
    if (!this.quoter) {
      throw new Error(`${this.name}: Quoter not configured`);
    }

    // Try V3-style multi-hop
    if (fees && this.v3QuoteSupported !== false) {
      try {
        const encodedPath = this.encodePath(tokens, fees);
        const result = await this.quoter.quoteExactInput.staticCall(encodedPath, amountIn);

        return {
          amountOut: result[0],
          path: tokens,
          feeTiers: fees,
          dex: this.name,
          type: this.type,
          gasEstimate: result[3],
          quoteMethod: 'v3',
        };
      } catch (err) {
        logger.debug({ err: err.message }, 'V3 multi-hop failed');
      }
    }

    // Try V2-style multi-hop
    if (this.v2QuoteSupported !== false) {
      try {
        const amounts = await this.quoter.getAmountsOut(amountIn, tokens);

        return {
          amountOut: amounts[amounts.length - 1],
          path: tokens,
          dex: this.name,
          type: this.type,
          quoteMethod: 'v2',
        };
      } catch (err) {
        logger.debug({ err: err.message }, 'V2 multi-hop failed');
      }
    }

    throw new Error(`${this.name}: Multi-hop quote failed`);
  }

  /**
   * Build swap calldata for V3 swap via Universal Router
   * @param {string} tokenIn - Input token
   * @param {string} tokenOut - Output token
   * @param {bigint} amountIn - Input amount
   * @param {bigint} minAmountOut - Minimum output
   * @param {string} recipient - Recipient address
   * @param {number} deadline - Unix timestamp deadline
   * @param {number} [feeTier] - Fee tier
   * @returns {{to: string, data: string, value: bigint}}
   */
  buildSwapCalldata(tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline, feeTier = null) {
    if (!this.router) {
      throw new Error(`${this.name}: Router not configured`);
    }

    // Build V3 swap via Universal Router
    const fee = feeTier || this.defaultFeeTier;
    const path = this.encodePath([tokenIn, tokenOut], [fee]);

    // Encode the V3_SWAP_EXACT_IN command input
    const abiCoder = AbiCoder.defaultAbiCoder();
    const input = abiCoder.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [recipient, amountIn, minAmountOut, path, false] // false = tokens not from msg.sender
    );

    // Command byte
    const commands = solidityPacked(['uint8'], [Commands.V3_SWAP_EXACT_IN]);

    // Encode execute call
    const routerInterface = new Interface(UNIVERSAL_ROUTER_ABI);
    const calldata = routerInterface.encodeFunctionData('execute(bytes,bytes[],uint256)', [
      commands,
      [input],
      deadline,
    ]);

    return {
      to: this.routerAddress,
      data: calldata,
      value: 0n,
    };
  }

  /**
   * Build swap calldata for V2 swap via Universal Router
   * @param {string} tokenIn - Input token
   * @param {string} tokenOut - Output token
   * @param {bigint} amountIn - Input amount
   * @param {bigint} minAmountOut - Minimum output
   * @param {string} recipient - Recipient address
   * @param {number} deadline - Unix timestamp deadline
   * @returns {{to: string, data: string, value: bigint}}
   */
  buildSwapCalldataV2(tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline) {
    if (!this.router) {
      throw new Error(`${this.name}: Router not configured`);
    }

    const path = [tokenIn, tokenOut];

    // Encode the V2_SWAP_EXACT_IN command input
    const abiCoder = AbiCoder.defaultAbiCoder();
    const input = abiCoder.encode(
      ['address', 'uint256', 'uint256', 'address[]', 'bool'],
      [recipient, amountIn, minAmountOut, path, false]
    );

    // Command byte
    const commands = solidityPacked(['uint8'], [Commands.V2_SWAP_EXACT_IN]);

    // Encode execute call
    const routerInterface = new Interface(UNIVERSAL_ROUTER_ABI);
    const calldata = routerInterface.encodeFunctionData('execute(bytes,bytes[],uint256)', [
      commands,
      [input],
      deadline,
    ]);

    return {
      to: this.routerAddress,
      data: calldata,
      value: 0n,
    };
  }

  /**
   * Build multi-hop swap calldata
   * @param {string[]} tokens - Token path
   * @param {number[]} fees - Fee tiers
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

    // If fees provided, use V3 path
    if (fees && fees.length > 0) {
      const path = this.encodePath(tokens, fees);

      const abiCoder = AbiCoder.defaultAbiCoder();
      const input = abiCoder.encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool'],
        [recipient, amountIn, minAmountOut, path, false]
      );

      const commands = solidityPacked(['uint8'], [Commands.V3_SWAP_EXACT_IN]);

      const routerInterface = new Interface(UNIVERSAL_ROUTER_ABI);
      const calldata = routerInterface.encodeFunctionData('execute(bytes,bytes[],uint256)', [
        commands,
        [input],
        deadline,
      ]);

      return {
        to: this.routerAddress,
        data: calldata,
        value: 0n,
      };
    }

    // V2-style multi-hop
    const abiCoder = AbiCoder.defaultAbiCoder();
    const input = abiCoder.encode(
      ['address', 'uint256', 'uint256', 'address[]', 'bool'],
      [recipient, amountIn, minAmountOut, tokens, false]
    );

    const commands = solidityPacked(['uint8'], [Commands.V2_SWAP_EXACT_IN]);

    const routerInterface = new Interface(UNIVERSAL_ROUTER_ABI);
    const calldata = routerInterface.encodeFunctionData('execute(bytes,bytes[],uint256)', [
      commands,
      [input],
      deadline,
    ]);

    return {
      to: this.routerAddress,
      data: calldata,
      value: 0n,
    };
  }

  /**
   * Verify contracts exist on-chain and detect quote support
   * @param {object} provider - RPC provider
   * @returns {Promise<boolean>}
   */
  async verify(provider) {
    const checks = [];

    if (this.routerAddress) {
      checks.push(
        provider.getCode(this.routerAddress).then(code => {
          if (!code || code === '0x') {
            throw new Error(`${this.name} router has no code at ${this.routerAddress}`);
          }
          logger.debug(`${this.name} router verified`);
        })
      );
    }

    if (this.quoterAddress) {
      checks.push(
        provider.getCode(this.quoterAddress).then(code => {
          if (!code || code === '0x') {
            logger.warn(`${this.name} quoter has no code at ${this.quoterAddress} - quoting disabled`);
            this.quoteSupported = false;
          } else {
            logger.debug(`${this.name} quoter verified`);
            this.quoteSupported = true;
          }
        })
      );
    }

    await Promise.all(checks);

    if (this.quoteSupported) {
      logger.info(`${this.name} (UniversalRouter) verification passed - quoting enabled`);
    } else {
      logger.warn(`${this.name} (UniversalRouter) verification passed - quoting DISABLED (no quoter)`);
    }

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
      feeBps: this.feeBps,
      defaultFeeTier: this.defaultFeeTier,
      chainId: this.chainId,
      quoteSupported: this.quoteSupported,
      v2QuoteSupported: this.v2QuoteSupported,
      v3QuoteSupported: this.v3QuoteSupported,
    };
  }
}

export default UniversalRouterAdapter;
