// ════════════════════════════════════════════════════════════
// UniswapV2 Adapter
// Standard V2-style router with getAmountsOut quoting
// Compatible with: SwapX, SushiSwap, most V2 forks
// ════════════════════════════════════════════════════════════

import { Contract, Interface } from 'ethers';
import { logger } from '../../logger.js';
import { getAmountOut } from '../../math.js';

// Minimal ABIs - only what we need
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function factory() external view returns (address)',
];

const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

const PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];

export class UniswapV2Adapter {
  constructor(name, config, provider) {
    this.name = name;
    this.type = 'uniswap_v2';
    this.chainId = config.chainId;
    this.routerAddress = config.router;
    this.factoryAddress = config.factory || null;
    this.feeBps = config.feeBps || 30;
    this.provider = provider;
    this.quoteSupported = true;

    // Create contract instances
    if (this.routerAddress) {
      this.router = new Contract(
        this.routerAddress,
        ROUTER_ABI,
        provider.getProvider()
      );
    }

    if (this.factoryAddress) {
      this.factory = new Contract(
        this.factoryAddress,
        FACTORY_ABI,
        provider.getProvider()
      );
    }

    logger.debug({
      name: this.name,
      type: this.type,
      router: this.routerAddress,
      factory: this.factoryAddress,
      feeBps: this.feeBps,
    }, 'UniswapV2Adapter initialized');
  }

  /**
   * Get quote for exact input swap
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {bigint} amountIn - Input amount
   * @returns {Promise<{amountOut: bigint, path: string[], dex: string}>}
   */
  async getQuote(tokenIn, tokenOut, amountIn) {
    if (!this.router) {
      throw new Error(`${this.name}: Router not configured`);
    }

    try {
      const path = [tokenIn, tokenOut];
      const amounts = await this.router.getAmountsOut(amountIn, path);

      return {
        amountOut: amounts[1],
        path,
        dex: this.name,
        type: this.type,
        feeTier: null, // V2 doesn't have fee tiers
      };
    } catch (err) {
      // Handle common revert reasons
      const msg = err.message || '';
      if (msg.includes('INSUFFICIENT_LIQUIDITY') ||
          msg.includes('INSUFFICIENT_INPUT_AMOUNT') ||
          msg.includes('INVALID_PATH')) {
        logger.debug({ dex: this.name, tokenIn, tokenOut }, 'No liquidity for pair');
      } else {
        logger.debug({ err: msg, dex: this.name }, 'Quote failed');
      }
      throw err;
    }
  }

  /**
   * Get quote for multi-hop path
   * @param {bigint} amountIn - Input amount
   * @param {string[]} path - Token path array
   * @returns {Promise<{amountOut: bigint, path: string[], dex: string}>}
   */
  async getQuoteMultiHop(amountIn, path) {
    if (!this.router) {
      throw new Error(`${this.name}: Router not configured`);
    }

    if (path.length < 2) {
      throw new Error('Path must have at least 2 tokens');
    }

    try {
      const amounts = await this.router.getAmountsOut(amountIn, path);

      return {
        amountOut: amounts[amounts.length - 1],
        path,
        dex: this.name,
        type: this.type,
        intermediateAmounts: amounts.map(a => a.toString()),
      };
    } catch (err) {
      logger.debug({ err: err.message, dex: this.name, path }, 'Multi-hop quote failed');
      throw err;
    }
  }

  /**
   * Get reserves from pair contract
   * @param {string} tokenA - First token address
   * @param {string} tokenB - Second token address
   * @returns {Promise<{reserveA: bigint, reserveB: bigint, pairAddress: string}>}
   */
  async getReserves(tokenA, tokenB) {
    if (!this.factory) {
      throw new Error(`${this.name}: Factory not configured`);
    }

    try {
      const pairAddress = await this.factory.getPair(tokenA, tokenB);

      if (pairAddress === '0x0000000000000000000000000000000000000000') {
        throw new Error(`No pair exists for ${tokenA}/${tokenB} on ${this.name}`);
      }

      const pair = new Contract(pairAddress, PAIR_ABI, this.provider.getProvider());
      const [reserve0, reserve1] = await pair.getReserves();
      const token0 = await pair.token0();

      // Determine which reserve corresponds to which token
      const [reserveA, reserveB] = token0.toLowerCase() === tokenA.toLowerCase()
        ? [reserve0, reserve1]
        : [reserve1, reserve0];

      return {
        reserveA,
        reserveB,
        pairAddress,
      };
    } catch (err) {
      logger.debug({ err: err.message, tokenA, tokenB }, `${this.name} reserves fetch failed`);
      throw err;
    }
  }

  /**
   * Calculate quote using reserves (faster, no RPC call if reserves cached)
   * @param {bigint} amountIn - Input amount
   * @param {bigint} reserveIn - Reserve of input token
   * @param {bigint} reserveOut - Reserve of output token
   * @returns {bigint} Output amount
   */
  calculateQuoteFromReserves(amountIn, reserveIn, reserveOut) {
    return getAmountOut(amountIn, reserveIn, reserveOut, this.feeBps);
  }

  /**
   * Build swap calldata for exact input swap
   * @param {string} tokenIn - Input token address
   * @param {string} tokenOut - Output token address
   * @param {bigint} amountIn - Input amount
   * @param {bigint} minAmountOut - Minimum output (slippage protection)
   * @param {string} recipient - Recipient address
   * @param {number} deadline - Unix timestamp deadline
   * @returns {{to: string, data: string, value: bigint}}
   */
  buildSwapCalldata(tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline) {
    if (!this.router) {
      throw new Error(`${this.name}: Router not configured`);
    }

    const routerInterface = new Interface(ROUTER_ABI);
    const path = [tokenIn, tokenOut];

    const calldata = routerInterface.encodeFunctionData('swapExactTokensForTokens', [
      amountIn,
      minAmountOut,
      path,
      recipient,
      deadline,
    ]);

    return {
      to: this.routerAddress,
      data: calldata,
      value: 0n,
    };
  }

  /**
   * Build swap calldata for multi-hop exact input swap
   * @param {string[]} path - Token path
   * @param {bigint} amountIn - Input amount
   * @param {bigint} minAmountOut - Minimum output
   * @param {string} recipient - Recipient address
   * @param {number} deadline - Unix timestamp deadline
   * @returns {{to: string, data: string, value: bigint}}
   */
  buildSwapCalldataMultiHop(path, amountIn, minAmountOut, recipient, deadline) {
    if (!this.router) {
      throw new Error(`${this.name}: Router not configured`);
    }

    const routerInterface = new Interface(ROUTER_ABI);

    const calldata = routerInterface.encodeFunctionData('swapExactTokensForTokens', [
      amountIn,
      minAmountOut,
      path,
      recipient,
      deadline,
    ]);

    return {
      to: this.routerAddress,
      data: calldata,
      value: 0n,
    };
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
            throw new Error(`${this.name} router has no code at ${this.routerAddress}`);
          }
          logger.debug(`${this.name} router verified`);
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
    logger.info(`${this.name} (V2) verification passed`);
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
      factory: this.factoryAddress,
      feeBps: this.feeBps,
      chainId: this.chainId,
      quoteSupported: this.quoteSupported,
    };
  }
}

export default UniswapV2Adapter;
