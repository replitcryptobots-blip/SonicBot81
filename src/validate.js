// ════════════════════════════════════════════════════════════
// Validation Module
// Validates configuration and on-chain contracts before startup
// ════════════════════════════════════════════════════════════

import { isAddress, Contract } from 'ethers';
import { config } from './config.js';
import { logger } from './logger.js';

/**
 * Validation error class
 */
export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/**
 * Validate Ethereum address
 */
export function validateAddress(address, name) {
  if (!address) {
    throw new ValidationError(`${name} is required`, name);
  }

  if (!isAddress(address)) {
    throw new ValidationError(`${name} is not a valid Ethereum address: ${address}`, name);
  }

  return address;
}

/**
 * Validate safety flags for live mode
 */
export function validateSafetyFlags() {
  const errors = [];

  // Kill switch check
  if (config.killSwitch) {
    throw new ValidationError('KILL_SWITCH is enabled - bot will not start', 'KILL_SWITCH');
  }

  // Live mode requires explicit confirmation
  if (config.liveMode && !config.dryRun) {
    if (!config.iUnderstandRisks) {
      errors.push('LIVE_MODE requires I_UNDERSTAND_RISKS=true');
    }

    logger.warn('═══════════════════════════════════════════════════════');
    logger.warn('  WARNING: LIVE MODE ENABLED');
    logger.warn('  Real transactions will be broadcast to the blockchain');
    logger.warn('  You can lose funds. Proceed with caution.');
    logger.warn('═══════════════════════════════════════════════════════');
  } else {
    logger.info('Running in DRY_RUN mode - no real transactions will be sent');
  }

  if (errors.length > 0) {
    throw new ValidationError(errors.join('; '), 'SAFETY');
  }
}

/**
 * Validate basic configuration
 */
export function validateConfig() {
  const errors = [];

  // Chain ID
  if (config.chainId !== 146) {
    errors.push(`Chain ID must be 146 (Sonic), got: ${config.chainId}`);
  }

  // RPC URLs
  if (!config.rpcUrls || config.rpcUrls.length === 0) {
    errors.push('At least one RPC_URL is required');
  }

  // Private key (only for live mode)
  if (config.liveMode && !config.dryRun) {
    if (!config.privateKey) {
      errors.push('PRIVATE_KEY is required for LIVE_MODE');
    }
  }

  // DEX configuration (required for live mode)
  if (config.liveMode && !config.dryRun) {
    if (!config.dex1.router) {
      errors.push('DEX1_ROUTER is required for LIVE_MODE');
    }
    if (!config.dex2.router) {
      errors.push('DEX2_ROUTER is required for LIVE_MODE');
    }
    if (!config.flashloan.provider) {
      errors.push('FLASHLOAN_PROVIDER is required for LIVE_MODE');
    }
    if (!config.flashloan.receiverContract) {
      errors.push('FLASHLOAN_RECEIVER_CONTRACT is required for LIVE_MODE - deploy contracts/FlashloanArbitrage.sol first');
    }
    if (!config.baseToken) {
      errors.push('BASE_TOKEN is required for LIVE_MODE');
    }
    if (config.watchTokens.length === 0) {
      errors.push('WATCH_TOKENS is required for LIVE_MODE');
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(errors.join('; '), 'CONFIG');
  }

  logger.info('Configuration validation passed');
}

/**
 * Validate addresses format
 */
export function validateAddresses() {
  const toValidate = [];

  // Only validate addresses that are set
  if (config.dex1.router) {
    toValidate.push({ address: config.dex1.router, name: 'DEX1_ROUTER' });
  }
  if (config.dex1.factory) {
    toValidate.push({ address: config.dex1.factory, name: 'DEX1_FACTORY' });
  }
  if (config.dex2.router) {
    toValidate.push({ address: config.dex2.router, name: 'DEX2_ROUTER' });
  }
  if (config.dex2.factory) {
    toValidate.push({ address: config.dex2.factory, name: 'DEX2_FACTORY' });
  }
  if (config.flashloan.provider) {
    toValidate.push({ address: config.flashloan.provider, name: 'FLASHLOAN_PROVIDER' });
  }
  if (config.flashloan.receiverContract) {
    toValidate.push({ address: config.flashloan.receiverContract, name: 'FLASHLOAN_RECEIVER_CONTRACT' });
  }
  if (config.baseToken) {
    toValidate.push({ address: config.baseToken, name: 'BASE_TOKEN' });
  }

  config.watchTokens.forEach((token, i) => {
    toValidate.push({ address: token, name: `WATCH_TOKENS[${i}]` });
  });

  for (const { address, name } of toValidate) {
    validateAddress(address, name);
  }

  logger.info({ count: toValidate.length }, 'Address format validation passed');
}

/**
 * Verify contract exists on-chain
 */
export async function verifyContractExists(provider, address, name) {
  try {
    const code = await provider.getCode(address);

    if (!code || code === '0x' || code === '0x0') {
      throw new ValidationError(
        `${name} (${address}) has no contract code - not deployed or wrong address`,
        name
      );
    }

    logger.debug({ address, name, codeSize: code.length }, 'Contract verified');
    return true;
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(
      `Failed to verify ${name} at ${address}: ${err.message}`,
      name
    );
  }
}

/**
 * Validate on-chain contracts (only for live mode)
 */
export async function validateOnChain(provider) {
  if (config.dryRun) {
    logger.info('Skipping on-chain validation (DRY_RUN mode)');
    return;
  }

  logger.info('Starting on-chain validation...');

  const checks = [];

  // Verify DEX routers
  if (config.dex1.router) {
    checks.push(verifyContractExists(provider, config.dex1.router, 'DEX1_ROUTER'));
  }
  if (config.dex2.router) {
    checks.push(verifyContractExists(provider, config.dex2.router, 'DEX2_ROUTER'));
  }

  // Verify flashloan provider
  if (config.flashloan.provider) {
    checks.push(verifyContractExists(provider, config.flashloan.provider, 'FLASHLOAN_PROVIDER'));
  }

  // Verify base token
  if (config.baseToken) {
    checks.push(verifyContractExists(provider, config.baseToken, 'BASE_TOKEN'));
  }

  // Verify watch tokens
  for (let i = 0; i < config.watchTokens.length; i++) {
    checks.push(
      verifyContractExists(provider, config.watchTokens[i], `WATCH_TOKENS[${i}]`)
    );
  }

  await Promise.all(checks);

  logger.info('On-chain validation passed - all contracts exist');
}

/**
 * Validate chain ID matches expected
 */
export async function validateChainId(provider) {
  const chainId = await provider.getChainId();

  if (chainId !== config.chainId) {
    throw new ValidationError(
      `Chain ID mismatch: expected ${config.chainId} (Sonic), got ${chainId}`,
      'CHAIN_ID'
    );
  }

  logger.info({ chainId }, 'Chain ID validated');
}

/**
 * Test RPC connectivity
 */
export async function testConnectivity(provider) {
  logger.info('Testing RPC connectivity...');

  try {
    const blockNumber = await provider.getBlockNumber();
    logger.info({ blockNumber }, 'RPC connectivity OK');

    const feeData = await provider.getFeeData();
    logger.info({ feeData: feeData.gasPrice?.toString() || 'EIP-1559' }, 'Fee data OK');

    return true;
  } catch (err) {
    throw new ValidationError(
      `RPC connectivity test failed: ${err.message}`,
      'RPC'
    );
  }
}

/**
 * Run all validations
 */
export async function runAllValidations(provider) {
  logger.info('Starting validation suite...');

  try {
    // 1. Safety flags
    validateSafetyFlags();

    // 2. Config validation
    validateConfig();

    // 3. Address format
    validateAddresses();

    // 4. RPC connectivity
    await testConnectivity(provider);

    // 5. Chain ID
    await validateChainId(provider);

    // 6. On-chain contracts (only in live mode)
    await validateOnChain(provider);

    logger.info('═══════════════════════════════════════════════════════');
    logger.info('  ✓ All validations passed');
    logger.info('═══════════════════════════════════════════════════════');

    return true;
  } catch (err) {
    logger.error({ err }, 'Validation failed');
    throw err;
  }
}

export default {
  validateAddress,
  validateSafetyFlags,
  validateConfig,
  validateAddresses,
  validateOnChain,
  validateChainId,
  testConnectivity,
  runAllValidations,
  ValidationError,
};
