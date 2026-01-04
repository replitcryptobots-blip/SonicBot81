// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * ════════════════════════════════════════════════════════════
 * FLASHLOAN ARBITRAGE RECEIVER CONTRACT
 * For Sonic Chain MEV Arbitrage Bot
 * ════════════════════════════════════════════════════════════
 *
 * DEPLOYMENT INSTRUCTIONS:
 * 1. Verify DEX router addresses for your target DEXes
 * 2. Deploy this contract
 * 3. Fund it with gas (0.1 S for gas costs)
 * 4. Set the deployed address in your bot config
 * 5. Transfer ownership to your bot wallet
 *
 * SECURITY NOTES:
 * - Only owner can execute arbitrage
 * - Contract does not hold funds (except temporary during flashloan)
 * - Profits are sent to owner immediately
 * - Emergency withdraw function included
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

interface IFlashloanProvider {
    function flashLoan(
        address recipient,
        address[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external;
}

/**
 * Flashloan Arbitrage Contract
 */
contract FlashloanArbitrage {
    address public owner;
    address public flashloanProvider;

    // DEX routers (configurable)
    mapping(string => address) public dexRouters;

    // Events
    event ArbitrageExecuted(
        address indexed token0,
        address indexed token1,
        uint256 profit,
        uint256 timestamp
    );

    event Withdrawn(address indexed token, uint256 amount, address indexed to);

    // Modifiers
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    constructor(address _flashloanProvider) {
        owner = msg.sender;
        flashloanProvider = _flashloanProvider;
    }

    /**
     * Register DEX router
     */
    function registerDex(string memory name, address router) external onlyOwner {
        dexRouters[name] = router;
    }

    /**
     * Execute flashloan arbitrage
     * Called by bot
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
    ) external onlyOwner {
        require(dexRouters[dex1Name] != address(0), "DEX1 not registered");
        require(dexRouters[dex2Name] != address(0), "DEX2 not registered");

        // Encode arbitrage parameters
        bytes memory userData = abi.encode(
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

        IFlashloanProvider(flashloanProvider).flashLoan(
            address(this),
            tokens,
            amounts,
            userData
        );
    }

    /**
     * Flashloan callback (Balancer-style)
     * Called by flashloan provider
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external {
        require(msg.sender == flashloanProvider, "Only flashloan provider");

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

        address dex1Router = dexRouters[dex1Name];
        address dex2Router = dexRouters[dex2Name];

        uint256 borrowAmount = amounts[0];
        uint256 flashloanFee = feeAmounts[0];
        uint256 repayAmount = borrowAmount + flashloanFee;

        // Step 1: Swap on DEX1 (token0 -> token1)
        IERC20(token0).approve(dex1Router, borrowAmount);

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
        IERC20(token1).approve(dex2Router, intermediateAmount);

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

        uint256 finalAmount = amounts2[1];

        // Step 3: Verify profit
        require(finalAmount >= repayAmount, "Arbitrage not profitable");

        // Step 4: Repay flashloan
        IERC20(token0).transfer(flashloanProvider, repayAmount);

        // Step 5: Send profit to owner
        uint256 profit = finalAmount - repayAmount;
        if (profit > 0) {
            IERC20(token0).transfer(owner, profit);

            emit ArbitrageExecuted(token0, token1, profit, block.timestamp);
        }
    }

    /**
     * Aave-style flashloan callback (alternative)
     */
    function executeOperation(
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata premiums,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == flashloanProvider, "Only flashloan provider");
        require(initiator == address(this), "Initiator must be this contract");

        // Convert to feeAmounts format
        uint256[] memory feeAmounts = premiums;

        // Call internal handler
        receiveFlashLoan(assets, amounts, feeAmounts, params);

        // Approve repayment
        for (uint i = 0; i < assets.length; i++) {
            uint256 amountOwed = amounts[i] + premiums[i];
            IERC20(assets[i]).approve(flashloanProvider, amountOwed);
        }

        return true;
    }

    /**
     * Emergency withdraw (in case funds get stuck)
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) {
            // Withdraw native token
            payable(owner).transfer(amount);
        } else {
            // Withdraw ERC20
            IERC20(token).transfer(owner, amount);
        }

        emit Withdrawn(token, amount, owner);
    }

    /**
     * Update flashloan provider
     */
    function setFlashloanProvider(address _provider) external onlyOwner {
        flashloanProvider = _provider;
    }

    /**
     * Transfer ownership
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid address");
        owner = newOwner;
    }

    // Receive native tokens
    receive() external payable {}
}
