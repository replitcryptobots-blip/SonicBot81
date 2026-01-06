// ════════════════════════════════════════════════════════════
// DEX Adapters Index
// Export all adapter types
// ════════════════════════════════════════════════════════════

export { UniswapV2Adapter } from './UniswapV2Adapter.js';
export { UniswapV3Adapter } from './UniswapV3Adapter.js';
export { UniversalRouterAdapter } from './UniversalRouterAdapter.js';

// Adapter type constants
export const AdapterTypes = {
  UNISWAP_V2: 'uniswap_v2',
  UNISWAP_V3: 'uniswap_v3',
  UNIVERSAL_ROUTER: 'universal_router',
};

// Factory function to create adapter based on type
import { UniswapV2Adapter } from './UniswapV2Adapter.js';
import { UniswapV3Adapter } from './UniswapV3Adapter.js';
import { UniversalRouterAdapter } from './UniversalRouterAdapter.js';

/**
 * Create adapter based on type
 * @param {string} name - DEX name
 * @param {string} type - Adapter type
 * @param {object} config - DEX configuration
 * @param {object} provider - RPC provider
 * @returns {object} Adapter instance
 */
export function createAdapter(name, type, config, provider) {
  switch (type.toLowerCase()) {
    case AdapterTypes.UNISWAP_V2:
      return new UniswapV2Adapter(name, config, provider);

    case AdapterTypes.UNISWAP_V3:
      return new UniswapV3Adapter(name, config, provider);

    case AdapterTypes.UNIVERSAL_ROUTER:
      return new UniversalRouterAdapter(name, config, provider);

    default:
      throw new Error(`Unknown adapter type: ${type}. Valid types: ${Object.values(AdapterTypes).join(', ')}`);
  }
}
