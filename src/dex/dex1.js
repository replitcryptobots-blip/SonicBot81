// ════════════════════════════════════════════════════════════
// DEX1 Adapter
// UniswapV2-compatible DEX adapter with quote and swap building
// ════════════════════════════════════════════════════════════

import { Contract, Interface } from 'ethers';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getAmountOut } from '../math.js';

// UniswapV2 Router ABI (minimal, for quotes and swaps)
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
  'function factory() external view returns (address)',
];

// UniswapV2 Factory ABI (minimal)
const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

// UniswapV2 Pair ABI (minimal)
const PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
];

export class Dex1Adapter {
  constructor(provider) {
    this.provider = provider;
    this.name = config.dex1.name;
    this.routerAddress = config.dex1.router;
    this.factoryAddress = config.dex1.factory;
    this.feeBps = config.dex1.feeBps;

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

    logger.info({
      name: this.name,
      router: this.routerAddress,
      factory: this.factoryAddress,
      feeBps: this.feeBps,
    }, 'DEX1 adapter initialized');
  }

  /**
   * Get quote for swap
   */
  async getQuote(tokenIn, tokenOut, amountIn) {
    if (!this.router) {
      throw new Error(`${this.name} router not configured`);
    }

    try {
      const path = [tokenIn, tokenOut];
      const amounts = await this.router.getAmountsOut(amountIn, path);

      return {
        amountOut: amounts[1],
        path,
        dex: this.name,
      };
    } catch (err) {
      logger.debug({ err, tokenIn, tokenOut, amountIn: amountIn.toString() }, `${this.name} quote failed`);
      throw err;
    }
  }

  /**
   * Get reserves from pair contract
   */
  async getReserves(tokenA, tokenB) {
    if (!this.factory) {
      throw new Error(`${this.name} factory not configured`);
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
      logger.debug({ err, tokenA, tokenB }, `${this.name} reserves fetch failed`);
      throw err;
    }
  }

  /**
   * Calculate quote using reserves (faster, no RPC call needed if reserves cached)
   */
  calculateQuoteFromReserves(amountIn, reserveIn, reserveOut) {
    return getAmountOut(amountIn, reserveIn, reserveOut, this.feeBps);
  }

  /**
   * Build swap calldata
   */
  buildSwapCalldata(tokenIn, tokenOut, amountIn, minAmountOut, recipient, deadline) {
    if (!this.router) {
      throw new Error(`${this.name} router not configured`);
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
   * Verify DEX contracts exist on-chain
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
    logger.info(`${this.name} verification passed`);
  }
}

export default Dex1Adapter;
