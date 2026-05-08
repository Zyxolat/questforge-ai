// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/security/ReentrancyGuard.sol';
import '@openzeppelin/contracts/security/Pausable.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

contract Treasury is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    
    IERC20 public rewardToken;
    mapping(address => uint256) public stakes;

    event Staked(address indexed player, uint256 amount);
    event Payout(address indexed player, uint256 amount);
    event Withdrawn(address indexed owner, uint256 amount);

    constructor(address tokenAddress) {
        require(tokenAddress != address(0), 'Invalid token address');
        rewardToken = IERC20(tokenAddress);
    }

    function stake(address player, uint256 amount) external payable whenNotPaused nonReentrant {
        require(player != address(0), 'Invalid player');
        require(amount > 0, 'Invalid stake amount');
        stakes[player] += amount;
        emit Staked(player, amount);
    }

    function payout(address player, uint256 amount) external onlyOwner whenNotPaused nonReentrant {
        require(player != address(0), 'Invalid player');
        require(amount > 0, 'Invalid payout amount');
        require(rewardToken.balanceOf(address(this)) >= amount, 'Insufficient reward pool');
        rewardToken.safeTransfer(player, amount);
        emit Payout(player, amount);
    }

    function fundPool(uint256 amount) external onlyOwner whenNotPaused nonReentrant {
        require(amount > 0, 'Invalid fund amount');
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
    }

    function emergencyWithdraw(address recipient, uint256 amount) external onlyOwner nonReentrant {
        require(recipient != address(0), 'Invalid recipient');
        require(amount > 0, 'Invalid withdrawal amount');
        require(rewardToken.balanceOf(address(this)) >= amount, 'Insufficient balance');
        rewardToken.safeTransfer(recipient, amount);
        emit Withdrawn(recipient, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    receive() external payable {}
}
