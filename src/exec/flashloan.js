// ════════════════════════════════════════════════════════════
// Flashloan Provider
// Interface and implementation for flashloan providers on Sonic
// ════════════════════════════════════════════════════════════

import { Contract, Interface } from 'ethers';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Balancer-style flashloan ABI
 * Used by Balancer Vault and compatible protocols
 */
const BALANCER_VAULT_ABI = [
  'function flashLoan(address recipient, address[] tokens, uint256[] amounts, bytes userData) external',
  'function getProtocolFeesCollector() external view returns (address)',
];

/**
 * Aave V3-style flashloan ABI
 * Used by Aave V3 Pool and compatible protocols
 */
const AAVE_POOL_ABI = [
  'function flashLoan(address receiverAddress, address[] assets, uint256[] amounts, uint256[] interestRateModes, address onBehalfOf, bytes params, uint16 referralCode) external',
  'function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes params, uint16 referralCode) external',
  'function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128)',
];

/**
 * Base Flashloan Provider interface
 */
export class FlashloanProvider {
  constructor(provider, providerAddress, feeBps, type) {
    this.provider = provider;
    this.address = providerAddress;
    this.feeBps = feeBps;
    this.type = type;
  }

  /**
   * Calculate flashloan fee
   */
  calculateFee(amount) {
    return (amount * BigInt(this.feeBps)) / 10000n;
  }

  /**
   * Get total repayment amount
   */
  getRepaymentAmount(borrowAmount) {
    return borrowAmount + this.calculateFee(borrowAmount);
  }

  /**
   * Verify provider contract exists (must be implemented)
   */
  async verify() {
    throw new Error('verify() must be implemented by subclass');
  }

  /**
   * Build flashloan calldata (must be implemented)
   */
  buildFlashloanCall(receiverAddress, tokens, amounts, userData) {
    throw new Error('buildFlashloanCall() must be implemented by subclass');
  }

  /**
   * Get provider info
   */
  getInfo() {
    return {
      type: this.type,
      address: this.address,
      feeBps: this.feeBps,
    };
  }
}

/**
 * Balancer-style Vault flashloan provider
 * Balancer Vault flashloans typically have 0 fee
 */
export class BalancerFlashloanProvider extends FlashloanProvider {
  constructor(provider, vaultAddress, feeBps = 0) {
    super(provider, vaultAddress, feeBps, 'balancer');
    this.vault = new Contract(vaultAddress, BALANCER_VAULT_ABI, provider.getProvider());
  }

  async verify() {
    const code = await this.provider.getCode(this.address);
    if (!code || code === '0x') {
      throw new Error(`Balancer Vault has no code at ${this.address}`);
    }

    // Try to call a view function to verify it's actually a Vault
    try {
      await this.vault.getProtocolFeesCollector();
      logger.info({
        address: this.address,
        type: this.type,
        feeBps: this.feeBps
      }, 'Balancer Vault verified');
    } catch (err) {
      logger.warn({
        address: this.address,
        error: err.message
      }, 'Could not verify Balancer Vault interface - contract exists but may not be compatible');
    }
  }

  buildFlashloanCall(receiverAddress, tokens, amounts, userData) {
    const vaultInterface = new Interface(BALANCER_VAULT_ABI);
    const calldata = vaultInterface.encodeFunctionData('flashLoan', [
      receiverAddress,
      tokens,
      amounts,
      userData,
    ]);

    return {
      to: this.address,
      data: calldata,
      value: 0n,
    };
  }
}

/**
 * Aave V3-style Pool flashloan provider
 * Default fee is 0.09% (9 bps) but can vary
 */
export class AaveFlashloanProvider extends FlashloanProvider {
  constructor(provider, poolAddress, feeBps = 9) {
    super(provider, poolAddress, feeBps, 'aave');
    this.pool = new Contract(poolAddress, AAVE_POOL_ABI, provider.getProvider());
  }

  async verify() {
    const code = await this.provider.getCode(this.address);
    if (!code || code === '0x') {
      throw new Error(`Aave Pool has no code at ${this.address}`);
    }

    // Try to get the flashloan premium to verify interface
    try {
      const premiumTotal = await this.pool.FLASHLOAN_PREMIUM_TOTAL();
      const actualFeeBps = Number(premiumTotal);

      if (actualFeeBps !== this.feeBps) {
        logger.warn({
          configured: this.feeBps,
          onChain: actualFeeBps,
          address: this.address
        }, 'Aave flashloan fee mismatch! Using on-chain value.');

        // Update to actual on-chain fee
        this.feeBps = actualFeeBps;
      }

      logger.info({
        address: this.address,
        type: this.type,
        feeBps: this.feeBps
      }, 'Aave Pool verified');
    } catch (err) {
      logger.warn({
        address: this.address,
        error: err.message
      }, 'Could not verify Aave Pool interface - contract exists but may not be V3 compatible');
    }
  }

  buildFlashloanCall(receiverAddress, tokens, amounts, userData) {
    const poolInterface = new Interface(AAVE_POOL_ABI);

    // Use flashLoanSimple for single asset (more gas efficient)
    if (tokens.length === 1) {
      const calldata = poolInterface.encodeFunctionData('flashLoanSimple', [
        receiverAddress,
        tokens[0],
        amounts[0],
        userData,
        0, // referral code
      ]);

      return {
        to: this.address,
        data: calldata,
        value: 0n,
      };
    }

    // Use flashLoan for multiple assets
    // interestRateModes: 0 = no debt (must repay in same tx)
    const interestRateModes = new Array(tokens.length).fill(0);

    const calldata = poolInterface.encodeFunctionData('flashLoan', [
      receiverAddress,
      tokens,
      amounts,
      interestRateModes,
      receiverAddress, // onBehalfOf
      userData,
      0, // referral code
    ]);

    return {
      to: this.address,
      data: calldata,
      value: 0n,
    };
  }
}

/**
 * Create flashloan provider from config
 * Uses FLASHLOAN_TYPE to determine provider class
 */
export function createFlashloanProvider(provider) {
  const flashloanType = config.flashloan.type;
  const address = config.flashloan.provider;
  const feeBps = config.flashloan.feeBps;

  // If type is 'none' or no address, return null
  if (flashloanType === 'none') {
    logger.info('Flashloan provider type is "none" - flashloans disabled');
    return null;
  }

  if (!address) {
    logger.warn('Flashloan provider address not configured');
    return null;
  }

  let flashloanProvider;

  switch (flashloanType) {
    case 'balancer':
      flashloanProvider = new BalancerFlashloanProvider(provider, address, feeBps);
      break;

    case 'aave':
      flashloanProvider = new AaveFlashloanProvider(provider, address, feeBps);
      break;

    default:
      throw new Error(
        `Unknown FLASHLOAN_TYPE: "${flashloanType}". ` +
        `Valid options: none, balancer, aave`
      );
  }

  logger.info({
    type: flashloanType,
    address,
    feeBps,
  }, 'Flashloan provider created');

  return flashloanProvider;
}

/**
 * Verify flashloan fee on-chain (where possible)
 * Returns verification result
 */
export async function verifyFlashloanFee(flashloanProvider) {
  if (!flashloanProvider) {
    return {
      verified: false,
      warning: 'No flashloan provider configured',
    };
  }

  const result = {
    type: flashloanProvider.type,
    configured: flashloanProvider.feeBps,
    verified: false,
    onChain: null,
    warning: null,
  };

  try {
    if (flashloanProvider.type === 'aave') {
      // Aave has on-chain fee query
      const pool = new Contract(
        flashloanProvider.address,
        AAVE_POOL_ABI,
        flashloanProvider.provider.getProvider()
      );

      const premiumTotal = await pool.FLASHLOAN_PREMIUM_TOTAL();
      result.onChain = Number(premiumTotal);
      result.verified = true;

      if (result.onChain !== result.configured) {
        result.warning = `Fee mismatch: configured ${result.configured} bps, on-chain ${result.onChain} bps`;
      }
    } else if (flashloanProvider.type === 'balancer') {
      // Balancer typically has 0 fee, but it's protocol-configurable
      // Cannot easily query, so we trust configuration
      result.warning = 'Balancer fee cannot be verified on-chain. Default is 0. Verify manually.';
      result.onChain = 0; // Typically 0
      result.verified = false;
    }
  } catch (err) {
    result.warning = `Fee verification failed: ${err.message}`;
  }

  logger.info({ result }, 'Flashloan fee verification');
  return result;
}

export default {
  FlashloanProvider,
  BalancerFlashloanProvider,
  AaveFlashloanProvider,
  createFlashloanProvider,
  verifyFlashloanFee,
};
