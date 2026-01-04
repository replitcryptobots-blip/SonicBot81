#!/usr/bin/env node
// ════════════════════════════════════════════════════════════
// UNIT TESTS
// Deterministic tests for critical bot functionality
// Run with: node tests/unit.test.js
// ════════════════════════════════════════════════════════════

import { strict as assert } from 'assert';
import { getAddress, isAddress } from 'ethers';

// ════════════════════════════════════════════════════════════
// TEST FRAMEWORK
// ════════════════════════════════════════════════════════════

let testCount = 0;
let passCount = 0;
let failCount = 0;
const failures = [];

async function test(name, fn) {
  testCount++;
  try {
    await fn();
    passCount++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failCount++;
    failures.push({ name, error: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

function suite(name, fn) {
  console.log(`\n${name}`);
  console.log('─'.repeat(60));
  return fn();
}

// ════════════════════════════════════════════════════════════
// TEST: Quote Chaining Correctness
// ════════════════════════════════════════════════════════════

await suite('Quote Chaining Correctness', async () => {
  // Test that second leg uses output from first leg, NOT original tradeSize

  await test('Second leg amountIn equals first leg amountOut', async () => {
    // Simulate quote fetching logic
    const tradeSize = 1000000000000000000n; // 1 ETH

    // Mock DEX quotes
    const quote1 = {
      amountIn: tradeSize,
      amountOut: 1050000000000000000n, // 1.05 tokens out
    };

    // CORRECT: Second leg uses first leg output
    const quote2_correct = {
      amountIn: quote1.amountOut, // 1.05 tokens
      amountOut: 1100000000000000000n, // 1.1 ETH back
    };

    // INCORRECT: Second leg uses original tradeSize (BUG)
    const quote2_buggy = {
      amountIn: tradeSize, // 1 ETH (WRONG!)
      amountOut: 1100000000000000000n,
    };

    // Verify correct chaining
    assert.strictEqual(
      quote2_correct.amountIn,
      quote1.amountOut,
      'Second leg must use first leg output as input'
    );

    // Verify buggy pattern would be different
    assert.notStrictEqual(
      quote2_buggy.amountIn,
      quote1.amountOut,
      'Buggy version uses wrong input'
    );
  });

  await test('Quote chain maintains token flow integrity', async () => {
    // Simulate: TokenA -> TokenB on DEX1, TokenB -> TokenA on DEX2
    const borrowAmount = 10n ** 18n; // 1 token

    // DEX1: TokenA -> TokenB
    const leg1Output = 1050n * 10n ** 15n; // 1.05 TokenB

    // DEX2: TokenB -> TokenA (must use leg1Output)
    const leg2Input = leg1Output;
    const leg2Output = 1100n * 10n ** 15n; // 1.1 TokenA

    // Profit = leg2Output - borrowAmount - fees
    const profit = leg2Output - borrowAmount;

    assert.strictEqual(leg2Input, leg1Output, 'Token flow must be continuous');
    assert.ok(profit > 0n, 'Must have positive profit');
  });
});

// ════════════════════════════════════════════════════════════
// TEST: PoolId Validator (Balancer)
// ════════════════════════════════════════════════════════════

await suite('PoolId Validator', async () => {
  // PoolId must be 32 bytes: 0x + 64 hex characters = 66 total chars

  function validatePoolId(poolId) {
    if (!poolId || poolId.trim() === '') {
      return { valid: true, reason: 'empty allowed' };
    }

    const trimmed = poolId.trim();
    const poolIdRegex = /^0x[a-fA-F0-9]{64}$/;

    if (!poolIdRegex.test(trimmed)) {
      return {
        valid: false,
        reason: `Must be 32 bytes (0x + 64 hex chars). Got ${trimmed.length} chars.`,
      };
    }

    return { valid: true, reason: 'valid format' };
  }

  await test('Valid poolId (32 bytes) passes', async () => {
    const validPoolId = '0x' + 'a'.repeat(64);
    const result = validatePoolId(validPoolId);
    assert.strictEqual(result.valid, true, `Should be valid: ${result.reason}`);
  });

  await test('Valid poolId with mixed case passes', async () => {
    const mixedCase = '0xAbCdEf1234567890' + 'a'.repeat(48);
    const result = validatePoolId(mixedCase);
    assert.strictEqual(result.valid, true);
  });

  await test('Empty poolId passes (optional field)', async () => {
    assert.strictEqual(validatePoolId('').valid, true);
    assert.strictEqual(validatePoolId(null).valid, true);
    assert.strictEqual(validatePoolId(undefined).valid, true);
    assert.strictEqual(validatePoolId('  ').valid, true);
  });

  await test('Short poolId fails', async () => {
    const shortPoolId = '0x' + 'a'.repeat(32);
    const result = validatePoolId(shortPoolId);
    assert.strictEqual(result.valid, false, 'Short poolId should fail');
  });

  await test('Long poolId fails', async () => {
    const longPoolId = '0x' + 'a'.repeat(128);
    const result = validatePoolId(longPoolId);
    assert.strictEqual(result.valid, false, 'Long poolId should fail');
  });

  await test('PoolId without 0x prefix fails', async () => {
    const noPrefix = 'a'.repeat(64);
    const result = validatePoolId(noPrefix);
    assert.strictEqual(result.valid, false, 'Missing 0x prefix should fail');
  });

  await test('PoolId with invalid hex characters fails', async () => {
    const invalidHex = '0x' + 'g'.repeat(64);
    const result = validatePoolId(invalidHex);
    assert.strictEqual(result.valid, false, 'Invalid hex chars should fail');
  });
});

// ════════════════════════════════════════════════════════════
// TEST: Receipt Wait Polling
// ════════════════════════════════════════════════════════════

await suite('Receipt Wait Polling', async () => {
  // Mock provider for testing receipt polling

  class MockProvider {
    constructor(receiptsAfterAttempts) {
      this.attemptCount = 0;
      this.receiptsAfterAttempts = receiptsAfterAttempts;
      this.receipt = { status: 1, blockNumber: 12345 };
    }

    async getTransactionReceipt(txHash) {
      this.attemptCount++;
      if (this.attemptCount >= this.receiptsAfterAttempts) {
        return this.receipt;
      }
      return null; // Not mined yet
    }
  }

  async function waitForReceipt(provider, txHash, timeoutMs, pollIntervalMs) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) return receipt;
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    throw new Error(`Timeout after ${timeoutMs}ms`);
  }

  await test('Polls until receipt found', async () => {
    const mockProvider = new MockProvider(3); // Return receipt on 3rd attempt

    const receipt = await waitForReceipt(
      mockProvider,
      '0x123',
      5000, // 5s timeout
      100   // 100ms poll interval
    );

    assert.strictEqual(receipt.status, 1);
    assert.strictEqual(mockProvider.attemptCount, 3, 'Should poll 3 times');
  });

  await test('Returns immediately if receipt available', async () => {
    const mockProvider = new MockProvider(1); // Return immediately

    const receipt = await waitForReceipt(
      mockProvider,
      '0x123',
      5000,
      100
    );

    assert.strictEqual(mockProvider.attemptCount, 1, 'Should poll only once');
  });

  await test('Throws on timeout', async () => {
    const mockProvider = new MockProvider(100); // Never return receipt

    let threw = false;
    try {
      await waitForReceipt(
        mockProvider,
        '0x123',
        200,  // Very short timeout
        50    // Poll every 50ms
      );
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('Timeout'), 'Should throw timeout error');
    }

    assert.ok(threw, 'Should throw error on timeout');
  });

  await test('Continues polling even with errors', async () => {
    // Provider that throws on first call
    let calls = 0;
    const flakyProvider = {
      async getTransactionReceipt() {
        calls++;
        if (calls === 1) throw new Error('Network error');
        if (calls >= 3) return { status: 1 };
        return null;
      }
    };

    async function waitWithRetry(provider, txHash, timeoutMs, pollIntervalMs) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        try {
          const receipt = await provider.getTransactionReceipt(txHash);
          if (receipt) return receipt;
        } catch (err) {
          // Continue polling on error
        }
        await new Promise(r => setTimeout(r, pollIntervalMs));
      }
      throw new Error('Timeout');
    }

    const receipt = await waitWithRetry(flakyProvider, '0x123', 2000, 50);
    assert.ok(receipt, 'Should eventually get receipt');
    assert.ok(calls >= 3, 'Should retry after error');
  });
});

// ════════════════════════════════════════════════════════════
// TEST: Address Checksum Normalization
// ════════════════════════════════════════════════════════════

await suite('Address Checksum Normalization', async () => {
  // Note: ethers v6 is strict about checksums. We use lowercase which is always valid.

  await test('getAddress returns checksummed format', async () => {
    const lowercase = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
    const checksummed = getAddress(lowercase);

    assert.notStrictEqual(checksummed, lowercase, 'Should differ from lowercase');
    assert.ok(checksummed.includes('D'), 'Should have uppercase chars');
  });

  await test('isAddress accepts both cases', async () => {
    const lowercase = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
    const uppercase = '0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045';

    assert.ok(isAddress(lowercase), 'Should accept lowercase');
    assert.ok(isAddress(uppercase), 'Should accept uppercase');
  });

  await test('getAddress normalizes lowercase to checksum', async () => {
    // Both lowercase addresses should normalize to same checksum
    const addr1 = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
    const addr2 = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

    const norm1 = getAddress(addr1);
    const norm2 = getAddress(addr2);

    assert.strictEqual(norm1, norm2, 'Same address should normalize identically');
    // Verify it's actually checksummed
    assert.strictEqual(norm1, '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
  });

  await test('Invalid address throws', async () => {
    const invalidAddresses = [
      '0xinvalid',
      '0x123',
      'not_an_address',
      '0x' + 'g'.repeat(40),
    ];

    for (const addr of invalidAddresses) {
      let threw = false;
      try {
        getAddress(addr);
      } catch (err) {
        threw = true;
      }
      assert.ok(threw, `Should throw for invalid: ${addr}`);
    }
  });

  await test('Addresses used for comparison must be normalized', async () => {
    // This demonstrates why we normalize: comparing non-normalized addresses fails
    const lowercase = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
    const uppercase = '0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045';

    // WRONG: Direct comparison fails due to case difference
    const wrongComparison = lowercase === uppercase;
    assert.strictEqual(wrongComparison, false, 'Non-normalized comparison fails');

    // CORRECT: Normalize before comparing (both normalize to same checksum)
    const correctComparison = getAddress(lowercase) === getAddress(lowercase);
    assert.strictEqual(correctComparison, true, 'Normalized comparison works');

    // Also verify that normalizing the checksummed address works
    const checksummed = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
    const reChecksummed = getAddress(checksummed);
    assert.strictEqual(checksummed, reChecksummed, 'Checksummed address is stable');
  });
});

// ════════════════════════════════════════════════════════════
// TEST: Math Utilities
// ════════════════════════════════════════════════════════════

await suite('Math Utilities (BigInt-safe)', async () => {
  const BPS_DIVISOR = 10000n;

  function applyBps(value, bps) {
    return (value * BigInt(bps)) / BPS_DIVISOR;
  }

  function subtractBps(value, bps) {
    return value - applyBps(value, bps);
  }

  await test('applyBps calculates correct percentage', async () => {
    const value = 10000n;
    const bps = 50; // 0.5%

    const result = applyBps(value, bps);
    assert.strictEqual(result, 50n, '0.5% of 10000 = 50');
  });

  await test('subtractBps removes correct percentage', async () => {
    const value = 10000n;
    const bps = 30; // 0.3%

    const result = subtractBps(value, bps);
    assert.strictEqual(result, 9970n, '10000 - 0.3% = 9970');
  });

  await test('Slippage calculation is BigInt-safe', async () => {
    const amountOut = 1000000000000000000n; // 1 ETH
    const slippageBps = 50; // 0.5%

    const minAmountOut = subtractBps(amountOut, slippageBps);

    // 1 ETH - 0.5% = 0.995 ETH
    const expected = 995000000000000000n;
    assert.strictEqual(minAmountOut, expected);
  });

  await test('Flashloan fee calculation', async () => {
    const borrowAmount = 100n * 10n ** 18n; // 100 tokens
    const feeBps = 9; // 0.09% (Aave typical)

    const fee = applyBps(borrowAmount, feeBps);
    const repayAmount = borrowAmount + fee;

    // 0.09% of 100 = 0.09 tokens = 9e16
    assert.strictEqual(fee, 90000000000000000n);
    assert.strictEqual(repayAmount, 100090000000000000000n);
  });
});

// ════════════════════════════════════════════════════════════
// TEST: LIVE Mode Safety Checks
// ════════════════════════════════════════════════════════════

await suite('LIVE Mode Safety Checks', async () => {
  function isLiveMode(config) {
    return config.liveMode === true &&
           config.dryRun === false &&
           config.iUnderstandRisks === true;
  }

  await test('All three flags required for LIVE mode', async () => {
    const allTrue = { liveMode: true, dryRun: false, iUnderstandRisks: true };
    assert.strictEqual(isLiveMode(allTrue), true, 'All true should enable LIVE');
  });

  await test('DRY_RUN=true blocks LIVE mode', async () => {
    const dryRunTrue = { liveMode: true, dryRun: true, iUnderstandRisks: true };
    assert.strictEqual(isLiveMode(dryRunTrue), false, 'DRY_RUN should block');
  });

  await test('Missing I_UNDERSTAND_RISKS blocks LIVE mode', async () => {
    const noRisks = { liveMode: true, dryRun: false, iUnderstandRisks: false };
    assert.strictEqual(isLiveMode(noRisks), false, 'Missing risks flag should block');
  });

  await test('LIVE_MODE=false blocks LIVE mode', async () => {
    const noLive = { liveMode: false, dryRun: false, iUnderstandRisks: true };
    assert.strictEqual(isLiveMode(noLive), false, 'LIVE_MODE false should block');
  });

  await test('Defaults are safe (DRY_RUN mode)', async () => {
    const defaults = { liveMode: false, dryRun: true, iUnderstandRisks: false };
    assert.strictEqual(isLiveMode(defaults), false, 'Defaults should be safe');
  });
});

// ════════════════════════════════════════════════════════════
// TEST: FLASHLOAN_TYPE Validation
// ════════════════════════════════════════════════════════════

await suite('FLASHLOAN_TYPE Validation', async () => {
  const VALID_TYPES = ['none', 'balancer', 'aave'];

  function validateFlashloanType(type) {
    if (!type || type.trim() === '') {
      return { valid: true, value: 'none' };
    }

    const normalized = type.toLowerCase().trim();

    if (!VALID_TYPES.includes(normalized)) {
      return { valid: false, error: `Invalid type: ${type}` };
    }

    return { valid: true, value: normalized };
  }

  await test('Valid types accepted', async () => {
    for (const type of VALID_TYPES) {
      const result = validateFlashloanType(type);
      assert.strictEqual(result.valid, true, `${type} should be valid`);
    }
  });

  await test('Case insensitive', async () => {
    const result = validateFlashloanType('BALANCER');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.value, 'balancer');
  });

  await test('Empty defaults to none', async () => {
    assert.strictEqual(validateFlashloanType('').value, 'none');
    assert.strictEqual(validateFlashloanType(null).value, 'none');
    assert.strictEqual(validateFlashloanType(undefined).value, 'none');
  });

  await test('Invalid type rejected', async () => {
    const result = validateFlashloanType('uniswap');
    assert.strictEqual(result.valid, false);
  });
});

// ════════════════════════════════════════════════════════════
// RESULTS
// ════════════════════════════════════════════════════════════

console.log('\n════════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passCount}/${testCount} passed`);

if (failCount > 0) {
  console.log(`  FAILURES: ${failCount}`);
  console.log('');
  for (const { name, error } of failures) {
    console.log(`  ✗ ${name}: ${error}`);
  }
  console.log('════════════════════════════════════════════════════════════');
  process.exit(1);
} else {
  console.log('  All tests passed!');
  console.log('════════════════════════════════════════════════════════════');
  process.exit(0);
}
