// ════════════════════════════════════════════════════════════
// Configuration Module
// Loads and validates environment variables with safe defaults
// ════════════════════════════════════════════════════════════

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
  // SAFETY
  // ════════════════════════════════════════════════════════════
  dryRun: parseBool(process.env.DRY_RUN, true), // SAFE DEFAULT
  liveMode: parseBool(process.env.LIVE_MODE, false),
  iUnderstandRisks: parseBool(process.env.I_UNDERSTAND_RISKS, false),
  killSwitch: parseBool(process.env.KILL_SWITCH, false),

  // ════════════════════════════════════════════════════════════
  // FLASHLOAN
  // ════════════════════════════════════════════════════════════
  flashloan: {
    provider: process.env.FLASHLOAN_PROVIDER || '',
    feeBps: parseNumber(process.env.FLASHLOAN_FEE_BPS, 5),
  },

  // ════════════════════════════════════════════════════════════
  // DEX
  // ════════════════════════════════════════════════════════════
  dex1: {
    name: process.env.DEX1_NAME || 'DEX1',
    router: process.env.DEX1_ROUTER || '',
    factory: process.env.DEX1_FACTORY || '',
    feeBps: parseNumber(process.env.DEX1_FEE_BPS, 30),
  },
  dex2: {
    name: process.env.DEX2_NAME || 'DEX2',
    router: process.env.DEX2_ROUTER || '',
    factory: process.env.DEX2_FACTORY || '',
    feeBps: parseNumber(process.env.DEX2_FEE_BPS, 30),
  },

  // ════════════════════════════════════════════════════════════
  // TOKENS
  // ════════════════════════════════════════════════════════════
  watchTokens: parseList(process.env.WATCH_TOKENS),
  baseToken: process.env.BASE_TOKEN || '',

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
 * Get sanitized config for display (no secrets)
 */
export function getSanitizedConfig() {
  return {
    ...config,
    privateKey: config.privateKey ? '***REDACTED***' : 'NOT_SET',
    flashloan: {
      ...config.flashloan,
    },
  };
}

export default config;
