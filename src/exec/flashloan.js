// ════════════════════════════════════════════════════════════
// Flashloan Provider
// Interface and implementation for flashloan providers on Sonic
// ════════════════════════════════════════════════════════════

import { Contract, Interface } from 'ethers';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Balancer-style flashloan ABI
 * This is a common pattern used by many protocols
 */
const BALANCER_VAULT_ABI = [
  'function flashLoan(address recipient, address[] tokens, uint256[] amounts, bytes userData) external',
];

/**
 * Aave-style flashloan ABI
 */
const AAVE_POOL_ABI = [
  'function flashLoan(address receiverAddress, address[] assets, uint256[] amounts, uint256[] modes, address onBehalfOf, bytes params, uint16 referralCode) external',
  'function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes params, uint16 referralCode) external',
];

/**
 * Flashloan receiver interface
 * Your contract must implement this to receive flashloans
 */
const FLASHLOAN_RECEIVER_ABI = [
  'function executeOperation(address[] assets, uint256[] amounts, uint256[] premiums, address initiator, bytes calldata params) external returns (bool)',
];

/**
 * Base Flashloan Provider interface
 */
export class FlashloanProvider {
  constructor(provider, providerAddress, feeBps) {
    this.provider = provider;
    this.address = providerAddress;
    this.feeBps = feeBps;
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
   * Verify provider contract exists
   */
  async verify() {
    throw new Error('verify() must be implemented by subclass');
  }

  /**
   * Build flashloan calldata
   */
  buildFlashloanCall(receiverAddress, tokens, amounts, userData) {
    throw new Error('buildFlashloanCall() must be implemented by subclass');
  }
}

/**
 * Balancer-style Vault flashloan provider
 */
export class BalancerFlashloanProvider extends FlashloanProvider {
  constructor(provider, vaultAddress, feeBps = 0) {
    super(provider, vaultAddress, feeBps);
    this.vault = new Contract(vaultAddress, BALANCER_VAULT_ABI, provider.getProvider());
    this.type = 'Balancer';
  }

  async verify() {
    const code = await this.provider.getCode(this.address);
    if (!code || code === '0x') {
      throw new Error(`Balancer Vault has no code at ${this.address}`);
    }
    logger.info({ address: this.address, type: this.type }, 'Flashloan provider verified');
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
 * Aave-style Pool flashloan provider
 */
export class AaveFlashloanProvider extends FlashloanProvider {
  constructor(provider, poolAddress, feeBps = 9) {
    super(provider, poolAddress, feeBps);
    this.pool = new Contract(poolAddress, AAVE_POOL_ABI, provider.getProvider());
    this.type = 'Aave';
  }

  async verify() {
    const code = await this.provider.getCode(this.address);
    if (!code || code === '0x') {
      throw new Error(`Aave Pool has no code at ${this.address}`);
    }
    logger.info({ address: this.address, type: this.type }, 'Flashloan provider verified');
  }

  buildFlashloanCall(receiverAddress, tokens, amounts, userData) {
    const poolInterface = new Interface(AAVE_POOL_ABI);

    // Use flashLoanSimple for single asset
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
    const modes = new Array(tokens.length).fill(0); // 0 = no debt

    const calldata = poolInterface.encodeFunctionData('flashLoan', [
      receiverAddress,
      tokens,
      amounts,
      modes,
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
 */
export function createFlashloanProvider(provider) {
  const address = config.flashloan.provider;
  const feeBps = config.flashloan.feeBps;

  if (!address) {
    logger.warn('Flashloan provider not configured');
    return null;
  }

  // Auto-detect provider type or default to Balancer
  // In production, you should explicitly configure this
  // For now, we'll use Balancer-style as it's common
  const flashloanProvider = new BalancerFlashloanProvider(provider, address, feeBps);

  logger.info({
    address,
    feeBps,
    type: flashloanProvider.type,
  }, 'Flashloan provider created');

  return flashloanProvider;
}

/**
 * Verify flashloan fee on-chain (if possible)
 * This is protocol-specific and should be implemented per provider
 */
export async function verifyFlashloanFee(provider, flashloanProvider) {
  // This is a placeholder - actual implementation depends on the protocol
  // Some protocols have a getFee() function, others have it hardcoded

  logger.warn(
    'Flashloan fee verification is protocol-specific. ' +
    'Please verify the fee manually by checking the protocol documentation or contract.'
  );

  return {
    configured: flashloanProvider.feeBps,
    verified: false,
    warning: 'Manual verification required',
  };
}

export default {
  FlashloanProvider,
  BalancerFlashloanProvider,
  AaveFlashloanProvider,
  createFlashloanProvider,
  verifyFlashloanFee,
};
