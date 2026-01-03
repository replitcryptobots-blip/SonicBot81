# Verification Checklist for Sonic MEV Bot

This checklist ensures you have verified all critical addresses and parameters before running in LIVE mode.

**⚠️ NEVER skip these steps! Incorrect addresses can result in loss of funds.**

---

## Pre-Flight Checklist

### 1. Chain Configuration

- [ ] Verified chain ID is 146 (Sonic mainnet)
- [ ] Tested RPC connectivity
- [ ] Confirmed RPC endpoints are operational

**How to verify:**
```bash
curl -X POST https://rpc.soniclabs.com \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
```

Expected result: `{"result":"0x92"}` (146 in decimal)

---

### 2. DEX1 Configuration

- [ ] DEX1_NAME is correct
- [ ] DEX1_ROUTER address is verified on block explorer
- [ ] DEX1_FACTORY address is verified on block explorer
- [ ] DEX1_FEE_BPS matches the actual pool fee

**How to verify:**

1. **Router Contract:**
   - Go to: https://sonicscan.org/address/[DEX1_ROUTER]
   - Check: Contract is verified
   - Check: Has `swapExactTokensForTokens` function
   - Check: Has `getAmountsOut` function
   - Check: Recent transactions show actual swaps

2. **Factory Contract:**
   - Go to: https://sonicscan.org/address/[DEX1_FACTORY]
   - Check: Contract is verified
   - Check: Has `getPair` function
   - Check: Can create/query pairs

3. **Fee Verification:**
   - Check DEX documentation for fee structure
   - Common: 30 bps (0.3%) for UniswapV2 forks
   - Verify by reading from a pair contract or documentation

**Record here:**
```
DEX1_NAME: _______________
DEX1_ROUTER: 0x_______________
DEX1_FACTORY: 0x_______________
DEX1_FEE_BPS: _____
Verified by: _______________
Date: _______________
```

---

### 3. DEX2 Configuration

- [ ] DEX2_NAME is correct
- [ ] DEX2_ROUTER address is verified on block explorer
- [ ] DEX2_FACTORY address is verified on block explorer
- [ ] DEX2_FEE_BPS matches the actual pool fee

**How to verify:** (Same as DEX1)

**Record here:**
```
DEX2_NAME: _______________
DEX2_ROUTER: 0x_______________
DEX2_FACTORY: 0x_______________
DEX2_FEE_BPS: _____
Verified by: _______________
Date: _______________
```

---

### 4. Flashloan Provider Configuration

- [ ] FLASHLOAN_PROVIDER address is verified
- [ ] Contract implements flashloan functionality
- [ ] FLASHLOAN_FEE_BPS is correct

**How to verify:**

1. **Provider Contract:**
   - Go to: https://sonicscan.org/address/[FLASHLOAN_PROVIDER]
   - Check: Contract is verified
   - Check: Has `flashLoan` or `flashLoanSimple` function
   - Identify protocol type (Balancer-style, Aave-style, etc.)

2. **Fee Verification:**
   - Check protocol documentation
   - Common fees:
     - Balancer: 0 bps (free)
     - Aave V3: 5-9 bps
     - Others: varies
   - If available, read fee from contract:
     ```javascript
     // Example for some protocols
     const vault = new Contract(address, ['function flashFee() view returns (uint256)'], provider);
     const fee = await vault.flashFee();
     ```

3. **Test Flashloan Availability:**
   - Verify the provider has sufficient liquidity
   - Check recent flashloan transactions

**Record here:**
```
FLASHLOAN_PROVIDER: 0x_______________
Provider Type: _______________ (Balancer/Aave/Other)
FLASHLOAN_FEE_BPS: _____
Max Available Liquidity: _______________ (per token)
Verified by: _______________
Date: _______________
```

---

### 5. Token Configuration

For EACH token in WATCH_TOKENS:

- [ ] Token address is verified
- [ ] Token is an ERC20
- [ ] Token has liquidity on DEX1
- [ ] Token has liquidity on DEX2
- [ ] Token symbol/name is correct

**How to verify:**

1. **Token Contract:**
   - Go to: https://sonicscan.org/address/[TOKEN_ADDRESS]
   - Check: Contract is verified
   - Check: Is ERC20 (has `transfer`, `balanceOf`, etc.)
   - Check: Symbol and name match expectations

2. **Liquidity Verification:**
   - Check DEX1 pair exists: `factory.getPair(tokenA, tokenB)`
   - Check DEX2 pair exists: `factory.getPair(tokenA, tokenB)`
   - Verify sufficient liquidity (> $10k recommended)

3. **Test Quote:**
   ```javascript
   const router = new Contract(dex1Router, routerAbi, provider);
   const amounts = await router.getAmountsOut(
     parseUnits('1', 18),
     [tokenA, tokenB]
   );
   console.log('Quote:', amounts);
   ```

**Record here:**

Token 1 (BASE_TOKEN):
```
Address: 0x_______________
Symbol: _____
Decimals: _____
Liquidity DEX1: $_______________
Liquidity DEX2: $_______________
Verified: [ ]
```

Token 2:
```
Address: 0x_______________
Symbol: _____
Decimals: _____
Liquidity DEX1: $_______________
Liquidity DEX2: $_______________
Verified: [ ]
```

*(Repeat for all tokens in watchlist)*

---

### 6. Flashloan Receiver Contract

**CRITICAL:** You MUST deploy a contract to execute the arbitrage.

- [ ] Smart contract written and tested
- [ ] Contract implements flashloan receiver interface
- [ ] Contract can execute swaps on DEX1 and DEX2
- [ ] Contract repays flashloan correctly
- [ ] Contract deployed to Sonic mainnet
- [ ] Deployment address verified
- [ ] Contract verified on block explorer
- [ ] Tested on testnet (if available)
- [ ] Executor.js updated with contract address

**Contract Requirements:**

1. Implements appropriate interface:
   - Balancer: `receiveFlashLoan`
   - Aave: `executeOperation`

2. Executes arbitrage logic:
   ```solidity
   1. Receive flashloan
   2. Approve DEX1 router for token spend
   3. Execute swap 1 on DEX1
   4. Approve DEX2 router for token spend
   5. Execute swap 2 on DEX2
   6. Approve flashloan provider for repayment
   7. Repay flashloan + fee
   8. Transfer profit to owner/caller
   9. Revert if unprofitable
   ```

3. Security checks:
   - [ ] Only callable by authorized address (bot wallet)
   - [ ] Validates minimum output amounts
   - [ ] Has emergency withdraw function
   - [ ] Reverts on unprofitable trades
   - [ ] Protected against reentrancy

**Record here:**
```
Contract Address: 0x_______________
Block Explorer: https://sonicscan.org/address/_______________
Deployed by: _______________
Deployment Tx: 0x_______________
Verified on Explorer: [ ]
Tested on Testnet: [ ]
Owner Address: 0x_______________
Date: _______________
```

---

### 7. Wallet Configuration

- [ ] Private key is secure and backed up
- [ ] Wallet address matches expected address
- [ ] Wallet funded with native tokens for gas
- [ ] Wallet has appropriate approvals (if needed)
- [ ] Using a DEDICATED wallet (not your main wallet)

**How to verify:**
```javascript
const wallet = new Wallet(privateKey, provider);
console.log('Address:', wallet.address);
const balance = await provider.getBalance(wallet.address);
console.log('Balance:', formatEther(balance), 'S');
```

**Recommended gas reserve:** 1-10 S (Sonic native token)

**Record here:**
```
Wallet Address: 0x_______________
Gas Balance: _____ S
Approved Tokens: _______________ (if any)
Backup Secured: [ ]
Dedicated Wallet: [ ]
```

---

### 8. Risk Parameters

- [ ] MIN_NET_PROFIT is reasonable
- [ ] MIN_NET_PROFIT_BPS is reasonable
- [ ] MAX_SLIPPAGE_BPS is conservative
- [ ] MAX_GAS_GWEI is set
- [ ] MAX_TRADE_SIZE is reasonable
- [ ] Circuit breaker configured

**Recommended starting values:**
```
MIN_NET_PROFIT=0.001         # Very small for testing
MIN_NET_PROFIT_BPS=50        # 0.5%
MAX_SLIPPAGE_BPS=50          # 0.5%
MAX_GAS_GWEI=100             # Adjust based on network
MAX_TRADE_SIZE=1             # Start small!
MAX_CONSECUTIVE_FAILURES=3   # Stop quickly if issues
```

**Record here:**
```
MIN_NET_PROFIT: _____
MIN_NET_PROFIT_BPS: _____
MAX_SLIPPAGE_BPS: _____
MAX_GAS_GWEI: _____
MAX_TRADE_SIZE: _____
MAX_CONSECUTIVE_FAILURES: _____
```

---

### 9. Testing

- [ ] Ran `npm run selftest` successfully
- [ ] Tested in DRY_RUN mode for at least 1 hour
- [ ] Observed opportunities being found
- [ ] Observed simulations accepting/rejecting correctly
- [ ] Reviewed logs for errors
- [ ] Verified no crashes or hangs
- [ ] Tested graceful shutdown (Ctrl+C)

**Record here:**
```
DRY_RUN Duration: _____ hours
Opportunities Found: _____
Opportunities Accepted: _____
Errors Observed: _______________ (none expected)
Test Date: _______________
```

---

### 10. Final Safety Checks

Before setting `LIVE_MODE=true`:

- [ ] ALL above sections completed
- [ ] Flashloan receiver contract deployed and tested
- [ ] Executor.js updated with correct contract address
- [ ] Using MINIMUM trade sizes
- [ ] Circuit breaker enabled
- [ ] Monitoring set up (log tailing)
- [ ] Know how to STOP the bot immediately
- [ ] Accept that you can lose funds
- [ ] Accept gas costs are non-refundable
- [ ] Understand there are NO guarantees

**Final confirmation:**
```
I have verified all addresses and parameters above.
I understand the risks of MEV arbitrage.
I accept that I can lose funds.
I know how to stop the bot in an emergency.

Signed: _______________
Date: _______________
```

---

## Emergency Contacts & Resources

**Sonic Block Explorer:**
- https://sonicscan.org

**Sonic Documentation:**
- https://docs.soniclabs.com

**Emergency Stop Methods:**
1. Press Ctrl+C in terminal
2. Set `KILL_SWITCH=true` in .env
3. Run: `pkill -f "node src/index.js"`

**Monitor Logs:**
```bash
tail -f logs/bot.jsonl
tail -f trades.jsonl
```

**Check State:**
```bash
cat state.json
```

---

## Common Verification Errors

### "Contract has no code"
- Address is wrong
- Contract not deployed on Sonic mainnet
- Using testnet address on mainnet

### "Function not found"
- Wrong ABI
- Not a UniswapV2-compatible router
- Contract is a proxy (use implementation address)

### "Pair does not exist"
- Tokens not paired on that DEX
- Wrong token addresses
- No liquidity

### "Flashloan fails"
- Provider address wrong
- Fee calculation incorrect
- Contract doesn't support that token
- Insufficient liquidity

---

## After Verification

Once ALL checks pass:

1. Update `.env`:
   ```env
   DRY_RUN=false
   LIVE_MODE=true
   I_UNDERSTAND_RISKS=true
   ```

2. Start small:
   - Use minimum trade sizes
   - Monitor closely for first hour
   - Check every transaction

3. Scale gradually:
   - If successful, slowly increase `MAX_TRADE_SIZE`
   - Adjust profit thresholds based on actual results
   - Add more token pairs gradually

4. Monitor continuously:
   - Check logs every few hours
   - Watch for circuit breaker triggers
   - Track actual vs expected profits
   - Monitor gas costs

---

**Remember: Due diligence saves funds. Never skip verification!**
