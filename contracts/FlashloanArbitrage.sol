// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ════════════════════════════════════════════════════════════
 * FLASHLOAN ARBITRAGE RECEIVER CONTRACT
 * For Sonic Chain MEV Arbitrage Bot
 * ════════════════════════════════════════════════════════════
 *
 * SUPPORTS:
 * - Balancer-style flashloans (receiveFlashLoan callback)
 * - Aave V3-style flashloans (executeOperation callback)
 *
 * DEPLOYMENT INSTRUCTIONS:
 * 1. Verify DEX router addresses for your target DEXes on Sonic
 * 2. Deploy this contract with the flashloan provider address
 * 3. Register your DEX routers using registerDex()
 * 4. Set the deployed address in your bot config (FLASHLOAN_RECEIVER_CONTRACT)
 * 5. Transfer ownership to your bot wallet
 *
 * SECURITY NOTES:
 * - Only owner can execute arbitrage
 * - Contract does not hold funds (except temporary during flashloan)
 * - Profits are sent to owner immediately
 * - Emergency withdraw function included
 * - Reentrancy protected by single-tx flashloan pattern
 */

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

interface IBalancerVault {
    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

interface IAavePool {
    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata interestRateModes,
        address onBehalfOf,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

/**
 * @title FlashloanArbitrage
 * @notice Executes atomic arbitrage using flashloans on Sonic chain
 * @dev Supports both Balancer and Aave-style flashloans
 */
contract FlashloanArbitrage {
    address public owner;
    address public flashloanProvider;

    // DEX routers (configurable)
    mapping(string => address) public dexRouters;

    // Execution lock to prevent reentrancy
    bool private _executing;

    // Events
    event ArbitrageExecuted(
        address indexed token0,
        address indexed token1,
        uint256 profit,
        uint256 gasUsed,
        uint256 timestamp
    );

    event DexRegistered(string indexed name, address router);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);
    event FlashloanProviderUpdated(address indexed oldProvider, address indexed newProvider);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    // Errors
    error OnlyOwner();
    error OnlyFlashloanProvider();
    error InvalidInitiator();
    error ExecutionLocked();
    error DexNotRegistered(string name);
    error ArbitrageNotProfitable(uint256 finalAmount, uint256 requiredAmount);
    error InvalidAddress();
    error TransferFailed();

    // Modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyFlashloanProvider() {
        if (msg.sender != flashloanProvider) revert OnlyFlashloanProvider();
        _;
    }

    modifier noReentrancy() {
        if (_executing) revert ExecutionLocked();
        _executing = true;
        _;
        _executing = false;
    }

    constructor(address _flashloanProvider) {
        if (_flashloanProvider == address(0)) revert InvalidAddress();
        owner = msg.sender;
        flashloanProvider = _flashloanProvider;
    }

    /**
     * @notice Register a DEX router
     * @param name Unique name for the DEX (e.g., "SpookySwap", "SwapX")
     * @param router Router contract address
     */
    function registerDex(string memory name, address router) external onlyOwner {
        if (router == address(0)) revert InvalidAddress();
        dexRouters[name] = router;
        emit DexRegistered(name, router);
    }

    /**
     * @notice Execute flashloan arbitrage
     * @dev Called by bot to initiate arbitrage
     * @param token0 Base token (borrowed token)
     * @param token1 Quote token
     * @param amount Amount to borrow
     * @param dex1Name Name of first DEX
     * @param dex2Name Name of second DEX
     * @param minIntermediate Minimum output from first swap
     * @param minFinalAmount Minimum final output (must exceed borrow + fee)
     * @param deadline Transaction deadline
     */
    function executeArbitrage(
        address token0,
        address token1,
        uint256 amount,
        string memory dex1Name,
        string memory dex2Name,
        uint256 minIntermediate,
        uint256 minFinalAmount,
        uint256 deadline
    ) external onlyOwner noReentrancy {
        if (dexRouters[dex1Name] == address(0)) revert DexNotRegistered(dex1Name);
        if (dexRouters[dex2Name] == address(0)) revert DexNotRegistered(dex2Name);

        // Encode arbitrage parameters
        bytes memory params = abi.encode(
            token0,
            token1,
            dex1Name,
            dex2Name,
            minIntermediate,
            minFinalAmount,
            deadline
        );

        // Request flashloan
        address[] memory tokens = new address[](1);
        tokens[0] = token0;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = amount;

        // Initiate flashloan (provider calls back our callback function)
        IBalancerVault(flashloanProvider).flashLoan(
            address(this),
            tokens,
            amounts,
            params
        );
    }

    /**
     * @notice Balancer-style flashloan callback
     * @dev Called by Balancer Vault after sending tokens
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external onlyFlashloanProvider {
        uint256 gasStart = gasleft();

        // Decode parameters
        (
            address token0,
            address token1,
            string memory dex1Name,
            string memory dex2Name,
            uint256 minIntermediate,
            uint256 minFinalAmount,
            uint256 deadline
        ) = abi.decode(userData, (address, address, string, string, uint256, uint256, uint256));

        uint256 borrowAmount = amounts[0];
        uint256 flashloanFee = feeAmounts[0];
        uint256 repayAmount = borrowAmount + flashloanFee;

        // Execute the arbitrage swaps
        uint256 finalAmount = _executeSwaps(
            token0,
            token1,
            dex1Name,
            dex2Name,
            borrowAmount,
            minIntermediate,
            minFinalAmount,
            deadline
        );

        // Verify profitability
        if (finalAmount < repayAmount) {
            revert ArbitrageNotProfitable(finalAmount, repayAmount);
        }

        // CRITICAL: Balancer pulls via transferFrom - must approve BEFORE callback returns
        IERC20(token0).approve(flashloanProvider, repayAmount);

        // Send profit to owner
        uint256 profit = finalAmount - repayAmount;
        if (profit > 0) {
            bool success = IERC20(token0).transfer(owner, profit);
            if (!success) revert TransferFailed();

            emit ArbitrageExecuted(
                token0,
                token1,
                profit,
                gasStart - gasleft(),
                block.timestamp
            );
        }
    }

    /**
     * @notice Aave V3-style flashloan callback
     * @dev Called by Aave Pool after sending tokens
     * @return True if operation successful (Aave will revert if false)
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external onlyFlashloanProvider returns (bool) {
        // Verify initiator is this contract
        if (initiator != address(this)) revert InvalidInitiator();

        uint256 gasStart = gasleft();

        // Decode parameters
        (
            address token0,
            address token1,
            string memory dex1Name,
            string memory dex2Name,
            uint256 minIntermediate,
            uint256 minFinalAmount,
            uint256 deadline
        ) = abi.decode(params, (address, address, string, string, uint256, uint256, uint256));

        uint256 borrowAmount = amounts[0];
        uint256 flashloanFee = premiums[0];
        uint256 repayAmount = borrowAmount + flashloanFee;

        // Execute the arbitrage swaps
        uint256 finalAmount = _executeSwaps(
            token0,
            token1,
            dex1Name,
            dex2Name,
            borrowAmount,
            minIntermediate,
            minFinalAmount,
            deadline
        );

        // Verify profitability
        if (finalAmount < repayAmount) {
            revert ArbitrageNotProfitable(finalAmount, repayAmount);
        }

        // Send profit to owner BEFORE approving repayment
        uint256 profit = finalAmount - repayAmount;
        if (profit > 0) {
            bool success = IERC20(token0).transfer(owner, profit);
            if (!success) revert TransferFailed();

            emit ArbitrageExecuted(
                token0,
                token1,
                profit,
                gasStart - gasleft(),
                block.timestamp
            );
        }

        // CRITICAL: Aave pulls via transferFrom AFTER this function returns
        // Must approve the EXACT repayment amount for each asset
        for (uint256 i = 0; i < assets.length; i++) {
            uint256 amountOwed = amounts[i] + premiums[i];
            IERC20(assets[i]).approve(flashloanProvider, amountOwed);
        }

        return true;
    }

    /**
     * @notice Internal function to execute the two-leg arbitrage swap
     * @dev Swaps token0 -> token1 on dex1, then token1 -> token0 on dex2
     */
    function _executeSwaps(
        address token0,
        address token1,
        string memory dex1Name,
        string memory dex2Name,
        uint256 borrowAmount,
        uint256 minIntermediate,
        uint256 minFinalAmount,
        uint256 deadline
    ) internal returns (uint256 finalAmount) {
        address dex1Router = dexRouters[dex1Name];
        address dex2Router = dexRouters[dex2Name];

        // Step 1: Swap on DEX1 (token0 -> token1)
        // Use max approval for gas efficiency on repeated executions
        IERC20(token0).approve(dex1Router, type(uint256).max);

        address[] memory path1 = new address[](2);
        path1[0] = token0;
        path1[1] = token1;

        uint[] memory amounts1 = IUniswapV2Router(dex1Router).swapExactTokensForTokens(
            borrowAmount,
            minIntermediate,
            path1,
            address(this),
            deadline
        );

        uint256 intermediateAmount = amounts1[1];

        // Step 2: Swap on DEX2 (token1 -> token0)
        // Use max approval for gas efficiency on repeated executions
        IERC20(token1).approve(dex2Router, type(uint256).max);

        address[] memory path2 = new address[](2);
        path2[0] = token1;
        path2[1] = token0;

        uint[] memory amounts2 = IUniswapV2Router(dex2Router).swapExactTokensForTokens(
            intermediateAmount,
            minFinalAmount,
            path2,
            address(this),
            deadline
        );

        finalAmount = amounts2[1];
    }

    /**
     * @notice Emergency withdraw (in case funds get stuck)
     * @param token Token address (address(0) for native token)
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            // Withdraw native token
            (bool success, ) = payable(owner).call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            // Withdraw ERC20
            bool success = IERC20(token).transfer(owner, amount);
            if (!success) revert TransferFailed();
        }

        emit Withdrawn(token, amount, owner);
    }

    /**
     * @notice Update flashloan provider address
     * @param _provider New provider address
     */
    function setFlashloanProvider(address _provider) external onlyOwner {
        if (_provider == address(0)) revert InvalidAddress();
        address oldProvider = flashloanProvider;
        flashloanProvider = _provider;
        emit FlashloanProviderUpdated(oldProvider, _provider);
    }

    /**
     * @notice Transfer ownership
     * @param newOwner New owner address
     */
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        address oldOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }

    /**
     * @notice Check if a DEX is registered
     * @param name DEX name
     * @return router Router address (address(0) if not registered)
     */
    function getDexRouter(string memory name) external view returns (address router) {
        return dexRouters[name];
    }

    /**
     * @notice Get contract balance for a token
     * @param token Token address
     * @return balance Token balance
     */
    function getTokenBalance(address token) external view returns (uint256 balance) {
        return IERC20(token).balanceOf(address(this));
    }

    // Receive native tokens (for gas)
    receive() external payable {}
}
