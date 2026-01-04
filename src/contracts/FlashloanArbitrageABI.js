// ════════════════════════════════════════════════════════════
// Flashloan Arbitrage Contract ABI
// ════════════════════════════════════════════════════════════

export const FLASHLOAN_ARBITRAGE_ABI = [
  'function owner() external view returns (address)',
  'function flashloanProvider() external view returns (address)',
  'function dexRouters(string memory name) external view returns (address)',
  'function registerDex(string memory name, address router) external',
  'function executeArbitrage(address token0, address token1, uint256 amount, string memory dex1Name, string memory dex2Name, uint256 minIntermediate, uint256 minFinalAmount, uint256 deadline) external',
  'function emergencyWithdraw(address token, uint256 amount) external',
  'function setFlashloanProvider(address _provider) external',
  'function transferOwnership(address newOwner) external',
  'event ArbitrageExecuted(address indexed token0, address indexed token1, uint256 profit, uint256 timestamp)',
  'event Withdrawn(address indexed token, uint256 amount, address indexed to)',
];

export default FLASHLOAN_ARBITRAGE_ABI;
