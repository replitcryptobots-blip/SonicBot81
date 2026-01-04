# Flashloan Arbitrage Contract Deployment Guide

## Prerequisites

1. **Foundry** (for Solidity compilation and deployment)
   ```bash
   curl -L https://foundry.paradigm.xyz | bash
   foundryup
   ```

2. **Or Hardhat** (alternative)
   ```bash
   npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox
   ```

3. **Wallet with S tokens** (for gas fees)
   - Minimum 0.5 S for deployment + testing

---

## Step 1: Compile the Contract

### Using Foundry:

```bash
cd /home/user/SonicBot81
forge build contracts/FlashloanArbitrage.sol
```

### Using Hardhat:

Create `hardhat.config.js`:
```javascript
require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: "0.8.20",
  networks: {
    sonic: {
      url: "https://rpc.soniclabs.com",
      chainId: 146,
      accounts: [process.env.PRIVATE_KEY]
    }
  }
};
```

Then compile:
```bash
npx hardhat compile
```

---

## Step 2: Deploy the Contract

### Option A: Using Foundry

```bash
# Set your private key
export PRIVATE_KEY="your_private_key_here"

# Set flashloan provider address (find on Sonic)
export FLASHLOAN_PROVIDER="0x..."

# Deploy
forge create contracts/FlashloanArbitrage.sol:FlashloanArbitrage \
  --rpc-url https://rpc.soniclabs.com \
  --private-key $PRIVATE_KEY \
  --constructor-args $FLASHLOAN_PROVIDER
```

### Option B: Using Hardhat

Create `scripts/deploy.js`:
```javascript
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const flashloanProvider = process.env.FLASHLOAN_PROVIDER;

  const FlashloanArbitrage = await ethers.getContractFactory("FlashloanArbitrage");
  const contract = await FlashloanArbitrage.deploy(flashloanProvider);
  await contract.deployed();

  console.log("Contract deployed to:", contract.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

Deploy:
```bash
npx hardhat run scripts/deploy.js --network sonic
```

---

## Step 3: Configure DEX Routers

After deployment, register your DEX routers:

```javascript
// Using ethers.js
const contract = new ethers.Contract(
  deployedAddress,
  FlashloanArbitrageABI,
  wallet
);

// Register DEX1
await contract.registerDex("DEX1", "0xDEX1_ROUTER_ADDRESS");

// Register DEX2
await contract.registerDex("DEX2", "0xDEX2_ROUTER_ADDRESS");
```

Or using cast (Foundry):
```bash
cast send $CONTRACT_ADDRESS \
  "registerDex(string,address)" \
  "DEX1" "0xDEX1_ROUTER_ADDRESS" \
  --rpc-url https://rpc.soniclabs.com \
  --private-key $PRIVATE_KEY
```

---

## Step 4: Fund the Contract (Optional)

The contract doesn't need to hold funds, but you may want to add a small amount for gas:

```bash
# Send 0.1 S for gas buffer
cast send $CONTRACT_ADDRESS \
  --value 0.1ether \
  --rpc-url https://rpc.soniclabs.com \
  --private-key $PRIVATE_KEY
```

---

## Step 5: Update Bot Configuration

Add the deployed contract address to your `.env`:

```bash
FLASHLOAN_RECEIVER_CONTRACT=0xYOUR_DEPLOYED_CONTRACT_ADDRESS
```

---

## Verification

Verify the contract on SonicScan (if available):

```bash
# Using Foundry
forge verify-contract \
  $CONTRACT_ADDRESS \
  contracts/FlashloanArbitrage.sol:FlashloanArbitrage \
  --chain sonic \
  --constructor-args $(cast abi-encode "constructor(address)" $FLASHLOAN_PROVIDER)
```

---

## Testing the Deployment

1. **Check ownership:**
   ```bash
   cast call $CONTRACT_ADDRESS "owner()" --rpc-url https://rpc.soniclabs.com
   ```

2. **Check flashloan provider:**
   ```bash
   cast call $CONTRACT_ADDRESS "flashloanProvider()" --rpc-url https://rpc.soniclabs.com
   ```

3. **Check DEX registration:**
   ```bash
   cast call $CONTRACT_ADDRESS "dexRouters(string)" "DEX1" --rpc-url https://rpc.soniclabs.com
   ```

---

## Security Checklist

- [ ] Contract deployed with correct flashloan provider
- [ ] Ownership matches your bot wallet
- [ ] DEX routers registered correctly
- [ ] Contract verified on block explorer (if possible)
- [ ] Test transaction executed successfully in DRY_RUN mode
- [ ] Emergency withdraw function tested

---

## Troubleshooting

### "Insufficient funds" error
- Ensure your wallet has enough S tokens for gas

### "Flashloan provider verification failed"
- Double-check the flashloan provider address
- Ensure it's a valid contract on Sonic

### "DEX not registered" error
- Run registerDex for all DEXes you're using
- Verify addresses are correct

---

## Emergency Procedures

### Withdraw stuck funds:
```bash
cast send $CONTRACT_ADDRESS \
  "emergencyWithdraw(address,uint256)" \
  $TOKEN_ADDRESS $AMOUNT \
  --rpc-url https://rpc.soniclabs.com \
  --private-key $PRIVATE_KEY
```

### Transfer ownership:
```bash
cast send $CONTRACT_ADDRESS \
  "transferOwnership(address)" \
  $NEW_OWNER_ADDRESS \
  --rpc-url https://rpc.soniclabs.com \
  --private-key $PRIVATE_KEY
```
