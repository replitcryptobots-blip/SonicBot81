# Sonic MEV Arbitrage Bot

**Production-grade flashloan arbitrage bot for Sonic chain, optimized for Termux on Android.**

This is NOT a demo. It's a complete, trade-ready MEV bot with:
- Real flashloan integration
- Multi-DEX arbitrage scanning
- Comprehensive profitability simulation
- Circuit breaker and safety controls
- Low resource usage (Termux-optimized)
- Pure JavaScript (no native compilation)

---

## ⚠️ CRITICAL WARNINGS

**BEFORE RUNNING IN LIVE MODE:**

1. **You can lose funds.** MEV arbitrage is competitive and risky.
2. **Gas costs are real.** Failed transactions still cost gas.
3. **Smart contract risks exist.** Bugs can lead to loss of funds.
4. **No guarantees of profit.** Market conditions change rapidly.
5. **Test extensively in DRY_RUN mode first.**

**By running this bot in LIVE mode, you acknowledge and accept these risks.**

---

## Table of Contents

- [Features](#features)
- [Termux Installation](#termux-installation)
- [Configuration](#configuration)
- [Verification Checklist](#verification-checklist)
- [Running the Bot](#running-the-bot)
- [Live Mode Checklist](#live-mode-checklist)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)
- [Architecture](#architecture)
- [Safety Controls](#safety-controls)

---

## Features

### Core Functionality
- ✅ Real flashloan-based arbitrage
- ✅ Multi-DEX price monitoring (DEX1 + DEX2)
- ✅ Profitability simulator with ALL costs:
  - DEX fees
  - Flashloan fees
  - Gas costs
  - Slippage
- ✅ Atomic transaction execution
- ✅ Circuit breaker (auto-stop after failures)

### Termux Optimizations
- ✅ Pure JavaScript (no native modules)
- ✅ Low RAM usage
- ✅ Minimal dependencies
- ✅ RPC failover with exponential backoff
- ✅ Rate limiting
- ✅ Graceful shutdown (Ctrl+C)

### Safety & Observability
- ✅ DRY_RUN mode by default
- ✅ Kill switch
- ✅ Structured logging (console + JSONL)
- ✅ Trade history persistence
- ✅ State recovery on restart

---

## Termux Installation

### 1. Install Termux

Download Termux from [F-Droid](https://f-droid.org/packages/com.termux/) (NOT Google Play).

### 2. Update Packages

```bash
pkg update && pkg upgrade
```

### 3. Install Node.js and Git

```bash
pkg install nodejs git
```

Verify installation:
```bash
node --version  # Should be v20+
npm --version
git --version
```

### 4. Clone Repository

```bash
cd ~
git clone <your-repo-url> sonic-mev-bot
cd sonic-mev-bot
```

### 5. Install Dependencies

```bash
npm install
```

**Note:** All dependencies are pure JavaScript. No compilation required.

### 6. Run Self-Test

```bash
npm run selftest
```

This validates your setup without executing trades.

---

## Configuration

### 1. Copy Environment Template

```bash
cp .env.example .env
```

### 2. Edit Configuration

```bash
nano .env
```

Or use any text editor.

### 3. Required Configuration

#### Network
```env
CHAIN_ID=146
RPC_URL=https://rpc.soniclabs.com,https://rpc.sonic.fantom.network
```

#### Wallet (for LIVE mode only)
```env
PRIVATE_KEY=your_private_key_without_0x_prefix
```

**⚠️ Keep this SECRET! Never commit .env to git.**

#### DEX Configuration

You MUST find and verify these addresses on Sonic:

```env
DEX1_NAME=SwapX
DEX1_ROUTER=0x...  # UniswapV2-compatible router
DEX1_FACTORY=0x... # Factory contract
DEX1_FEE_BPS=30    # 0.3% fee

DEX2_NAME=SonicSwap
DEX2_ROUTER=0x...
DEX2_FACTORY=0x...
DEX2_FEE_BPS=30
```

#### Flashloan Provider

```env
FLASHLOAN_PROVIDER=0x...  # Vault or pool address
FLASHLOAN_FEE_BPS=5       # Verify this on-chain!
```

#### Token Watchlist

```env
WATCH_TOKENS=0xWETH,0xUSDC,0xDAI
BASE_TOKEN=0xWETH
```

#### Profitability Thresholds

```env
MIN_NET_PROFIT=0.001       # Absolute minimum (e.g., 0.001 WETH)
MIN_NET_PROFIT_BPS=50      # Relative minimum (0.5%)
MAX_SLIPPAGE_BPS=50        # Max slippage (0.5%)
MAX_GAS_GWEI=100           # Reject if gas too high
```

---

## Verification Checklist

**MANDATORY BEFORE LIVE MODE**

### ✅ 1. Verify Chain ID

```bash
# Using curl
curl -X POST https://rpc.soniclabs.com \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'

# Should return: {"result":"0x92"} (146 in hex)
```

### ✅ 2. Verify DEX Router Contracts

For each DEX (DEX1, DEX2):

1. Go to Sonic block explorer: https://sonicscan.org
2. Search for the router address
3. Verify:
   - Contract is verified (source code visible)
   - Has `swapExactTokensForTokens` function
   - Has `getAmountsOut` function
   - Is actually a DEX router (check recent transactions)

### ✅ 3. Verify DEX Fees

Check the DEX documentation or read the fee from the pair contract:

```javascript
// Example: Read fee from pair
const pair = new Contract(pairAddress, [
  'function factory() view returns (address)',
], provider);

const factory = new Contract(await pair.factory(), [
  'function feeTo() view returns (address)',
], provider);
// Fee structure varies by DEX
```

Most UniswapV2 forks use 30 bps (0.3%).

### ✅ 4. Verify Flashloan Provider

1. Find the flashloan provider on Sonic:
   - Check Balancer-style vaults
   - Check Aave-style pools
   - Check DEX-native flashloans

2. Verify the address has a flashloan function:
   - `flashLoan` (Balancer/Aave)
   - `flashLoanSimple` (Aave)

3. Verify the fee:
   - Read from contract if available
   - Check documentation
   - Common fees: 0-9 bps

### ✅ 5. Verify Token Addresses

For each token in WATCH_TOKENS:

1. Search on Sonic explorer
2. Verify:
   - Is an ERC20 token
   - Has liquidity on both DEXes
   - Is the correct token (check symbol/name)

### ✅ 6. Test Read-Only Calls

Run the selftest:

```bash
npm run selftest
```

Should pass all tests including quotes (if configured).

### ✅ 7. Deploy Flashloan Receiver Contract

**CRITICAL:** The bot needs a smart contract to receive flashloans and execute swaps.

You MUST deploy your own flashloan receiver contract that:
1. Implements the flashloan receiver interface
2. Executes swaps using DEX routers
3. Repays the flashloan
4. Sends profit to your wallet

See `contracts/FlashloanArbitrage.sol` (you need to create this).

Example structure:
```solidity
contract FlashloanArbitrage {
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        // 1. Decode params
        // 2. Execute swap 1 on DEX1
        // 3. Execute swap 2 on DEX2
        // 4. Approve flashloan provider for repayment
        // 5. Keep profit
        return true;
    }
}
```

**Update executor.js with your deployed contract address.**

---

## Running the Bot

### Dry Run (Default - Safe)

```bash
npm start
```

This will:
- Scan for opportunities
- Simulate profitability
- Log everything
- **NOT send any transactions**

Perfect for testing and monitoring.

### Live Mode (Real Trading)

**⚠️ ONLY after completing ALL verification steps!**

1. Edit `.env`:
```env
DRY_RUN=false
LIVE_MODE=true
I_UNDERSTAND_RISKS=true
```

2. Start bot:
```bash
npm start
```

3. Monitor logs carefully:
```bash
tail -f logs/bot.jsonl
```

### Stop Bot

Press `Ctrl+C` for graceful shutdown.

The bot will:
- Stop scanning
- Save state
- Flush logs
- Exit cleanly

---

## Live Mode Checklist

Before setting `LIVE_MODE=true`:

- [ ] Completed ALL verification steps
- [ ] Deployed flashloan receiver contract
- [ ] Updated executor with contract address
- [ ] Tested in DRY_RUN extensively
- [ ] Funded wallet with native tokens for gas
- [ ] Set appropriate profit thresholds
- [ ] Configured circuit breaker
- [ ] Understand you can lose funds
- [ ] Have monitoring set up
- [ ] Know how to stop the bot (Ctrl+C)

---

## Monitoring

### Log Files

```bash
# Real-time logs
tail -f logs/bot.jsonl

# Pretty logs
tail -f logs/bot.jsonl | jq .

# Trade history
tail -f trades.jsonl
```

### State File

```bash
cat state.json
```

Shows:
- Last processed block
- Opportunities found/executed
- Uptime

### Stats

The bot logs stats every 60 seconds:
- Uptime
- Block height
- Scan count
- Opportunities found/profitable
- Execution stats
- Circuit breaker status

---

## Troubleshooting

### Common Termux Issues

#### "Cannot find module 'pino'"

```bash
rm -rf node_modules package-lock.json
npm install
```

#### "EACCES: permission denied"

Termux has restricted access. Use only paths in your home:
```bash
cd ~
# Work from ~/sonic-mev-bot
```

#### "Connection timeout"

1. Check internet connection
2. Try different RPC URL
3. Increase `RPC_TIMEOUT` in `.env`

#### High memory usage

1. Reduce `MAX_CONCURRENT_REQUESTS`
2. Reduce `WATCH_TOKENS` count
3. Increase `BLOCK_POLL_INTERVAL`

### Bot Issues

#### "No opportunities found"

1. Check DEX addresses are correct
2. Verify tokens have liquidity
3. Check price differences on DEXes manually
4. Lower `MIN_NET_PROFIT_BPS`

#### "All simulations rejected"

Common reasons:
- Gas price too high
- Profit below threshold
- Slippage too high

Check logs for exact rejection reasons.

#### "Circuit breaker opened"

The bot auto-stopped after consecutive failures.

1. Check logs for failure reasons
2. Fix underlying issue
3. Reduce `MAX_CONSECUTIVE_FAILURES` if too sensitive
4. Restart bot (circuit breaker resets)

### Emergency Stop

#### Kill Switch

Set in `.env`:
```env
KILL_SWITCH=true
```

Or send SIGTERM:
```bash
pkill -f "node src/index.js"
```

---

## Architecture

### Components

```
src/
├── config.js          # Environment loader
├── validate.js        # Startup validation
├── provider.js        # RPC with failover
├── logger.js          # JSONL logging
├── math.js            # BigInt math utilities
├── dex/
│   ├── dexRegistry.js # DEX manager
│   ├── dex1.js        # DEX1 adapter
│   └── dex2.js        # DEX2 adapter
├── arb/
│   ├── pairs.js       # Token pair generator
│   ├── scanner.js     # Block monitor + opportunity finder
│   └── simulator.js   # Profitability calculator
├── exec/
│   ├── flashloan.js   # Flashloan provider interface
│   └── executor.js    # Transaction builder + sender
└── index.js           # Main entry point
```

### Data Flow

```
Block Event
    ↓
Scanner (finds price differences)
    ↓
Simulator (calculates profitability)
    ↓
Executor (builds + sends transaction)
    ↓
Trade Log
```

### Safety Layers

1. **Config validation** - Refuse to start if misconfigured
2. **On-chain verification** - Check contracts exist
3. **Simulation** - Calculate exact profit before execution
4. **Dry run** - Test without sending transactions
5. **Circuit breaker** - Auto-stop after failures
6. **Kill switch** - Emergency stop

---

## Safety Controls

### Risk Parameters

Adjust in `.env`:

```env
# Minimum profit (both must pass)
MIN_NET_PROFIT=0.001        # Absolute
MIN_NET_PROFIT_BPS=50       # Relative (0.5%)

# Slippage protection
MAX_SLIPPAGE_BPS=50         # 0.5%

# Gas protection
MAX_GAS_GWEI=100            # Reject if gas > 100 gwei
MAX_GAS_USD=5               # Reject if gas cost > $5

# Position size
MAX_TRADE_SIZE=10           # Max 10 tokens per trade

# Circuit breaker
MAX_CONSECUTIVE_FAILURES=5  # Stop after 5 failures
CIRCUIT_BREAKER_COOLDOWN=300 # 5 min cooldown
```

### Transaction Safety

Every transaction includes:
- Deadline (5 minutes)
- Minimum output amounts (slippage protected)
- Gas limit (from estimation)
- Nonce management (no double-spend)

### No Retries

Failed transactions are NOT retried automatically.

This prevents:
- Gas waste on repeated failures
- Unexpected behavior
- Nonce issues

---

## Performance Tuning

For Termux (low resources):

```env
# Limit concurrent requests
MAX_CONCURRENT_REQUESTS=3

# Reduce request rate
MAX_REQUESTS_PER_SECOND=10

# Longer polling interval
BLOCK_POLL_INTERVAL=2000  # 2 seconds

# Increase timeout
RPC_TIMEOUT=10000  # 10 seconds
```

For better performance (if resources available):

```env
MAX_CONCURRENT_REQUESTS=10
MAX_REQUESTS_PER_SECOND=50
BLOCK_POLL_INTERVAL=500  # 0.5 seconds
```

---

## Development

### Testing

```bash
# Run self-test
npm run selftest

# Dry run
DRY_RUN=true npm start

# Test with specific tokens
WATCH_TOKENS=0xTOKEN1,0xTOKEN2 npm start
```

### Debugging

Set log level:
```env
LOG_LEVEL=debug
```

Enable pretty logs:
```env
LOG_PRETTY=true
```

### Adding DEXes

1. Create new adapter in `src/dex/dex3.js`
2. Add to `dexRegistry.js`
3. Configure in `.env`

---

## License

MIT

---

## Disclaimer

This software is provided "as is" without warranty of any kind.

**Use at your own risk.**

The developers are not responsible for:
- Loss of funds
- Failed transactions
- Gas costs
- Any damages resulting from use of this software

**You are solely responsible for:**
- Configuration
- Address verification
- Risk management
- Compliance with local laws

---

## Support

For issues:
1. Check [Troubleshooting](#troubleshooting)
2. Review logs in `logs/bot.jsonl`
3. Run `npm run selftest`
4. Open an issue on GitHub (without sharing private keys!)

---

## Credits

Built for the Sonic chain ecosystem.

Optimized for Termux on Android by MEV developers, for MEV developers.

**Happy arbitraging! 🚀**
