# SONIC MEV BOT - LIVE MODE CHECKLIST

## ⚠️ CRITICAL: Complete ALL items before enabling LIVE_MODE

This checklist ensures your bot is properly configured for Sonic mainnet (chainId 146).
**DO NOT enable LIVE_MODE until every item is verified!**

---

## 1. ON-CHAIN VERIFICATION (Required)

Run these verification commands using Node.js with ethers v6:

```javascript
// verification.js - Run with: node verification.js
import { ethers } from 'ethers';

const RPC_URL = 'YOUR_RPC_URL';
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Replace with YOUR addresses from .env
const addresses = {
  DEX1_ROUTER: 'YOUR_DEX1_ROUTER',
  DEX2_ROUTER: 'YOUR_DEX2_ROUTER',
  FLASHLOAN_PROVIDER: 'YOUR_FLASHLOAN_PROVIDER',
  FLASHLOAN_RECEIVER: 'YOUR_DEPLOYED_CONTRACT',
  BASE_TOKEN: 'YOUR_BASE_TOKEN',
};

async function verify() {
  console.log('Sonic MEV Bot - On-Chain Verification');
  console.log('=====================================\n');

  // 1. Verify Chain ID
  const network = await provider.getNetwork();
  const chainId = Number(network.chainId);
  console.log(`Chain ID: ${chainId}`);
  if (chainId !== 146) {
    console.error('❌ FAIL: Chain ID must be 146 (Sonic mainnet)');
    process.exit(1);
  }
  console.log('✅ Chain ID verified (146 - Sonic)\n');

  // 2. Verify contracts have code
  for (const [name, address] of Object.entries(addresses)) {
    if (!address || address.startsWith('YOUR_')) {
      console.log(`⏭️  SKIP: ${name} not configured`);
      continue;
    }

    const code = await provider.getCode(address);
    if (!code || code === '0x') {
      console.error(`❌ FAIL: ${name} has no code at ${address}`);
      process.exit(1);
    }
    console.log(`✅ ${name}: Contract exists (${(code.length - 2) / 2} bytes)`);
  }

  console.log('\n✅ All configured contracts verified!\n');
}

verify().catch(console.error);
```

### Checklist:

- [ ] **Chain ID = 146** (Sonic mainnet)
- [ ] **DEX1_ROUTER** has contract code on-chain
- [ ] **DEX2_ROUTER** has contract code on-chain
- [ ] **FLASHLOAN_PROVIDER** has contract code on-chain
- [ ] **FLASHLOAN_RECEIVER_CONTRACT** (your deployed contract) has code on-chain
- [ ] **BASE_TOKEN** is a valid ERC20 contract
- [ ] **All WATCH_TOKENS** are valid ERC20 contracts

---

## 2. FLASHLOAN PROVIDER VERIFICATION

### For Balancer-style (FLASHLOAN_TYPE=balancer):

```javascript
// Test Balancer Vault interface
const BALANCER_ABI = [
  'function getProtocolFeesCollector() view returns (address)'
];
const vault = new ethers.Contract(FLASHLOAN_PROVIDER, BALANCER_ABI, provider);
const collector = await vault.getProtocolFeesCollector();
console.log('Balancer Vault verified. Fee collector:', collector);
```

- [ ] Balancer Vault contract responds to `getProtocolFeesCollector()`
- [ ] FLASHLOAN_FEE_BPS is correct (typically 0 for Balancer)

### For Aave-style (FLASHLOAN_TYPE=aave):

```javascript
// Test Aave Pool interface
const AAVE_ABI = [
  'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)'
];
const pool = new ethers.Contract(FLASHLOAN_PROVIDER, AAVE_ABI, provider);
const premium = await pool.FLASHLOAN_PREMIUM_TOTAL();
console.log('Aave Pool verified. Premium:', premium.toString(), 'bps');
```

- [ ] Aave Pool contract responds to `FLASHLOAN_PREMIUM_TOTAL()`
- [ ] FLASHLOAN_FEE_BPS matches on-chain value

---

## 3. DEX ROUTER VERIFICATION

```javascript
// Test UniswapV2-style router interface
const ROUTER_ABI = [
  'function factory() view returns (address)',
  'function WETH() view returns (address)'
];

for (const [name, addr] of [['DEX1', DEX1_ROUTER], ['DEX2', DEX2_ROUTER]]) {
  if (!addr) continue;
  const router = new ethers.Contract(addr, ROUTER_ABI, provider);
  try {
    const factory = await router.factory();
    const weth = await router.WETH();
    console.log(`${name}: Factory=${factory}, WETH=${weth}`);
  } catch (err) {
    console.error(`❌ ${name}: Not a UniswapV2-style router!`);
  }
}
```

- [ ] **DEX1_ROUTER** implements `factory()` and `WETH()`
- [ ] **DEX2_ROUTER** implements `factory()` and `WETH()`
- [ ] DEX fees (DEX1_FEE_BPS, DEX2_FEE_BPS) match actual DEX fees

---

## 4. YOUR FLASHLOAN RECEIVER CONTRACT

### Pre-deployment Checklist:

- [ ] Reviewed `contracts/FlashloanArbitrage.sol` for security
- [ ] Compiled with Solidity ^0.8.20
- [ ] Deployed to Sonic mainnet
- [ ] Constructor parameter: correct FLASHLOAN_PROVIDER address
- [ ] Called `registerDex("DEX1", DEX1_ROUTER)`
- [ ] Called `registerDex("DEX2", DEX2_ROUTER)`
- [ ] Ownership transferred to your bot wallet (if needed)

### Post-deployment Verification:

```javascript
const ARB_ABI = [
  'function owner() view returns (address)',
  'function flashloanProvider() view returns (address)',
  'function getDexRouter(string) view returns (address)'
];

const arbContract = new ethers.Contract(FLASHLOAN_RECEIVER, ARB_ABI, provider);

console.log('Owner:', await arbContract.owner());
console.log('Provider:', await arbContract.flashloanProvider());
console.log('DEX1 Router:', await arbContract.getDexRouter('DEX1'));
console.log('DEX2 Router:', await arbContract.getDexRouter('DEX2'));
```

- [ ] `owner()` returns your bot wallet address
- [ ] `flashloanProvider()` returns correct provider
- [ ] `getDexRouter("DEX1")` returns DEX1_ROUTER
- [ ] `getDexRouter("DEX2")` returns DEX2_ROUTER

---

## 5. WALLET SETUP

- [ ] Bot wallet has sufficient native token (S) for gas (~0.1 S minimum)
- [ ] Private key is correctly set in `.env` (without 0x prefix)
- [ ] Wallet address matches expected

```javascript
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
console.log('Bot wallet:', wallet.address);
const balance = await provider.getBalance(wallet.address);
console.log('Balance:', ethers.formatEther(balance), 'S');
```

---

## 6. TOKEN CONFIGURATION

- [ ] BASE_TOKEN is a liquid token (WETH, USDC, etc.)
- [ ] All WATCH_TOKENS are verified ERC20 contracts
- [ ] Trading pairs exist on both DEXes

```javascript
const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)'
];

for (const addr of [BASE_TOKEN, ...WATCH_TOKENS]) {
  const token = new ethers.Contract(addr, ERC20_ABI, provider);
  console.log(`${addr}: ${await token.symbol()} (${await token.decimals()} decimals)`);
}
```

---

## 7. PROFITABILITY SETTINGS

Review these settings in your `.env`:

| Setting | Current Value | Recommended |
|---------|---------------|-------------|
| MIN_NET_PROFIT | | 0.001+ |
| MIN_NET_PROFIT_BPS | | 30-100 |
| MAX_SLIPPAGE_BPS | | 30-100 |
| MAX_GAS_GWEI | | Chain-appropriate |
| GAS_ESTIMATE_BUFFER_PERCENT | | 20-50 |

- [ ] Settings are realistic for Sonic gas costs
- [ ] Profit thresholds account for all fees

---

## 8. SAFETY CONFIGURATION

### REQUIRED for LIVE_MODE:

```
DRY_RUN=false           # Must be explicitly false
LIVE_MODE=true          # Must be true
I_UNDERSTAND_RISKS=true # Must acknowledge risks
KILL_SWITCH=false       # Must be false to run
```

- [ ] All four flags set correctly
- [ ] You understand and accept the risks
- [ ] KILL_SWITCH mechanism tested

---

## 9. TESTING SEQUENCE

Before enabling LIVE_MODE:

1. **Run unit tests:**
   ```bash
   npm run test
   ```
   - [ ] All unit tests pass

2. **Run self-test:**
   ```bash
   npm run selftest
   ```
   - [ ] All self-tests pass

3. **Run in DRY_RUN mode for at least 1 hour:**
   ```bash
   npm run dry-run
   ```
   - [ ] Bot connects to RPC
   - [ ] Block monitoring works
   - [ ] Quote fetching works
   - [ ] Opportunities detected (if any)
   - [ ] Simulations produce reasonable results

4. **Review DRY_RUN logs:**
   - [ ] No unexpected errors
   - [ ] Gas estimates reasonable
   - [ ] Profit calculations make sense

---

## 10. FINAL CHECKLIST

### I confirm:

- [ ] I have verified ALL contract addresses on Sonic block explorer
- [ ] I have tested the bot in DRY_RUN mode
- [ ] I understand I can lose funds
- [ ] I have a separate, dedicated wallet for this bot
- [ ] I have reviewed the smart contract code
- [ ] I know how to use KILL_SWITCH in emergencies
- [ ] I accept all risks

### To enable LIVE_MODE:

```bash
# In .env file:
DRY_RUN=false
LIVE_MODE=true
I_UNDERSTAND_RISKS=true
KILL_SWITCH=false

# Then run:
npm start
```

---

## EMERGENCY PROCEDURES

### To stop the bot immediately:

1. Set `KILL_SWITCH=true` in `.env` and restart
2. OR press Ctrl+C to terminate

### If funds are stuck in contract:

```javascript
// Call emergencyWithdraw on your FlashloanArbitrage contract
const contract = new ethers.Contract(
  FLASHLOAN_RECEIVER,
  ['function emergencyWithdraw(address token, uint256 amount)'],
  wallet
);
await contract.emergencyWithdraw(tokenAddress, amount);
```

---

## SUPPORT

- GitHub Issues: https://github.com/your-repo/issues
- Sonic Docs: https://docs.soniclabs.com/

**TRADE AT YOUR OWN RISK. NO GUARANTEES OF PROFIT.**
