// ════════════════════════════════════════════════════════════
// Configuration Module
// Loads and validates environment variables with safe defaults
// ════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getAddress, isAddress } from 'ethers';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file
dotenv.config({ path: join(__dirname, '..', '.env') });

/**
 * Parse boolean from env var
 */
function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Parse number from env var
 */
function parseNumber(value, defaultValue) {
  const num = Number(value);
  return isNaN(num) ? defaultValue : num;
}

/**
 * Parse comma-separated list
 */
function parseList(value, defaultValue = []) {
  if (!value) return defaultValue;
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Normalize Ethereum address to checksummed format
 * Returns empty string for empty input, throws for invalid addresses
 * @param {string} address - Raw address
 * @param {string} name - Config key name for error messages
 * @returns {string} - Checksummed address or empty string
 */
function normalizeAddress(address, name) {
  if (!address || address.trim() === '') {
    return '';
  }

  const trimmed = address.trim();

  if (!isAddress(trimmed)) {
    throw new Error(`Invalid Ethereum address for ${name}: "${trimmed}"`);
  }

  // Return checksummed address
  return getAddress(trimmed);
}

/**
 * Normalize array of addresses
 */
function normalizeAddressList(addresses, name) {
  return addresses.map((addr, i) => {
    if (!addr || addr.trim() === '') {
      return ''; // Skip empty entries
    }
    return normalizeAddress(addr, `${name}[${i}]`);
  }).filter(Boolean); // Remove empty entries
}

/**
 * Validate FLASHLOAN_TYPE
 */
const VALID_FLASHLOAN_TYPES = ['none', 'balancer', 'aave'];

function parseFlashloanType(value) {
  if (!value || value.trim() === '') {
    return 'none'; // Default to none - must be explicitly configured
  }

  const normalized = value.toLowerCase().trim();

  if (!VALID_FLASHLOAN_TYPES.includes(normalized)) {
    throw new Error(
      `Invalid FLASHLOAN_TYPE: "${value}". Must be one of: ${VALID_FLASHLOAN_TYPES.join(', ')}`
    );
  }

  return normalized;
}

/**
 * Validate poolId format (Balancer-specific)
 * Must be 32 bytes: 0x + 64 hex characters
 */
function validatePoolId(poolId, name) {
  if (!poolId || poolId.trim() === '') {
    return '';
  }

  const trimmed = poolId.trim();

  // Must be 0x + 64 hex chars = 66 total characters
  const poolIdRegex = /^0x[a-fA-F0-9]{64}$/;

  if (!poolIdRegex.test(trimmed)) {
    throw new Error(
      `Invalid ${name}: "${trimmed}". ` +
      `Balancer poolId must be 32 bytes (0x + 64 hex characters). ` +
      `Got ${trimmed.length} characters.`
    );
  }

  return trimmed.toLowerCase();
}

/**
 * Main configuration object
 * All values loaded from environment with safe defaults
 */
export const config = {
  // ════════════════════════════════════════════════════════════
  // NETWORK
  // ════════════════════════════════════════════════════════════
  chainId: parseNumber(process.env.CHAIN_ID, 146), // Sonic mainnet
  rpcUrls: parseList(process.env.RPC_URL, ['https://rpc.soniclabs.com']),
  wsRpcUrl: process.env.WS_RPC_URL || '',

  // ════════════════════════════════════════════════════════════
  // WALLET
  // ════════════════════════════════════════════════════════════
  privateKey: process.env.PRIVATE_KEY || '',

  // ════════════════════════════════════════════════════════════
  // SAFETY (CRITICAL!)
  // ════════════════════════════════════════════════════════════
  dryRun: parseBool(process.env.DRY_RUN, true), // SAFE DEFAULT: true
  liveMode: parseBool(process.env.LIVE_MODE, false), // SAFE DEFAULT: false
  iUnderstandRisks: parseBool(process.env.I_UNDERSTAND_RISKS, false),
  killSwitch: parseBool(process.env.KILL_SWITCH, false),

  // ════════════════════════════════════════════════════════════
  // FLASHLOAN (CRITICAL - Sonic-specific)
  // ════════════════════════════════════════════════════════════
  flashloan: {
    // FLASHLOAN_TYPE: 'none' | 'balancer' | 'aave'
    // Must be explicitly set for LIVE mode
    type: parseFlashloanType(process.env.FLASHLOAN_TYPE),

    // Provider address (Vault for Balancer, Pool for Aave)
    provider: normalizeAddress(process.env.FLASHLOAN_PROVIDER || '', 'FLASHLOAN_PROVIDER'),

    // Fee in basis points (verify on-chain!)
    feeBps: parseNumber(process.env.FLASHLOAN_FEE_BPS, 5),

    // Your deployed FlashloanArbitrage contract
    receiverContract: normalizeAddress(
      process.env.FLASHLOAN_RECEIVER_CONTRACT || '',
      'FLASHLOAN_RECEIVER_CONTRACT'
    ),

    // Balancer-specific: poolId (optional, for weighted pools)
    poolId: validatePoolId(process.env.FLASHLOAN_POOL_ID || '', 'FLASHLOAN_POOL_ID'),
  },

  // ════════════════════════════════════════════════════════════
  // DEX
  // ════════════════════════════════════════════════════════════
  dex1: {
    name: process.env.DEX1_NAME || 'DEX1',
    router: normalizeAddress(process.env.DEX1_ROUTER || '', 'DEX1_ROUTER'),
    factory: normalizeAddress(process.env.DEX1_FACTORY || '', 'DEX1_FACTORY'),
    feeBps: parseNumber(process.env.DEX1_FEE_BPS, 30),
  },
  dex2: {
    name: process.env.DEX2_NAME || 'DEX2',
    router: normalizeAddress(process.env.DEX2_ROUTER || '', 'DEX2_ROUTER'),
    factory: normalizeAddress(process.env.DEX2_FACTORY || '', 'DEX2_FACTORY'),
    feeBps: parseNumber(process.env.DEX2_FEE_BPS, 30),
  },

  // ════════════════════════════════════════════════════════════
  // TOKENS
  // ════════════════════════════════════════════════════════════
  watchTokens: normalizeAddressList(
    parseList(process.env.WATCH_TOKENS),
    'WATCH_TOKENS'
  ),
  baseToken: normalizeAddress(process.env.BASE_TOKEN || '', 'BASE_TOKEN'),

  // ════════════════════════════════════════════════════════════
  // PROFITABILITY
  // ════════════════════════════════════════════════════════════
  profit: {
    minNetProfit: process.env.MIN_NET_PROFIT || '0.001',
    minNetProfitBps: parseNumber(process.env.MIN_NET_PROFIT_BPS, 50),
    maxSlippageBps: parseNumber(process.env.MAX_SLIPPAGE_BPS, 50),
    maxGasGwei: parseNumber(process.env.MAX_GAS_GWEI, 100),
    maxGasUsd: parseNumber(process.env.MAX_GAS_USD, 5),
    maxTradeSize: process.env.MAX_TRADE_SIZE || '10',
    gasEstimateBuffer: parseNumber(process.env.GAS_ESTIMATE_BUFFER_PERCENT, 20), // 20% buffer
  },

  // ════════════════════════════════════════════════════════════
  // CIRCUIT BREAKER
  // ════════════════════════════════════════════════════════════
  circuitBreaker: {
    maxConsecutiveFailures: parseNumber(process.env.MAX_CONSECUTIVE_FAILURES, 5),
    cooldownSeconds: parseNumber(process.env.CIRCUIT_BREAKER_COOLDOWN, 300),
  },

  // ════════════════════════════════════════════════════════════
  // PERFORMANCE
  // ════════════════════════════════════════════════════════════
  performance: {
    blockPollInterval: parseNumber(process.env.BLOCK_POLL_INTERVAL, 2000),
    rpcTimeout: parseNumber(process.env.RPC_TIMEOUT, 10000),
    maxConcurrentRequests: parseNumber(process.env.MAX_CONCURRENT_REQUESTS, 3),
    maxRequestsPerSecond: parseNumber(process.env.MAX_REQUESTS_PER_SECOND, 10),
    txConfirmationTimeout: parseNumber(process.env.TX_CONFIRMATION_TIMEOUT, 60000), // 60s
    txPollInterval: parseNumber(process.env.TX_POLL_INTERVAL, 1000), // 1s
  },

  // ════════════════════════════════════════════════════════════
  // LOGGING
  // ════════════════════════════════════════════════════════════
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    pretty: parseBool(process.env.LOG_PRETTY, true),
    logFile: process.env.LOG_FILE || 'logs/bot.jsonl',
    stateFile: process.env.STATE_FILE || 'state.json',
    tradesFile: process.env.TRADES_FILE || 'trades.jsonl',
  },
};

/**
 * Check if we're in effective LIVE mode
 * LIVE mode requires ALL of:
 * - LIVE_MODE=true
 * - DRY_RUN=false (explicitly!)
 * - I_UNDERSTAND_RISKS=true
 */
export function isLiveMode() {
  return config.liveMode === true &&
         config.dryRun === false &&
         config.iUnderstandRisks === true;
}

/**
 * Get sanitized config for display (no secrets)
 */
export function getSanitizedConfig() {
  return {
    ...config,
    privateKey: config.privateKey ? '***REDACTED***' : 'NOT_SET',
    isLiveMode: isLiveMode(),
    flashloan: {
      ...config.flashloan,
      type: config.flashloan.type,
    },
  };
}

export default config;
