// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/security/ReentrancyGuard.sol';
import '@openzeppelin/contracts/security/Pausable.sol';
import '@openzeppelin/contracts/token/ERC20/IERC20.sol';

contract Treasury is Ownable, ReentrancyGuard, Pausable {
    IERC20 public rewardToken;
    mapping(address => uint256) public stakes;

    event Staked(address indexed player, uint256 amount);
    event Payout(address indexed player, uint256 amount);
    event Withdrawn(address indexed owner, uint256 amount);

    constructor(address tokenAddress) {
        rewardToken = IERC20(tokenAddress);
    }

    function stake(address player, uint256 amount) external payable whenNotPaused nonReentrant {
        require(player != address(0), 'Invalid player');
        require(amount > 0, 'Invalid stake');
        stakes[player] += amount;
        emit Staked(player, amount);
    }

    function payout(address player, uint256 amount) external onlyOwner whenNotPaused nonReentrant {
        require(amount > 0, 'Invalid amount');
        require(rewardToken.balanceOf(address(this)) >= amount, 'Insufficient reward pool');
        rewardToken.transfer(player, amount);
        emit Payout(player, amount);
    }

    function fundPool(uint256 amount) external onlyOwner whenNotPaused {
        require(amount > 0, 'Invalid fund');
        rewardToken.transferFrom(msg.sender, address(this), amount);
    }

    function emergencyWithdraw(address recipient, uint256 amount) external onlyOwner nonReentrant {
        rewardToken.transfer(recipient, amount);
        emit Withdrawn(recipient, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
