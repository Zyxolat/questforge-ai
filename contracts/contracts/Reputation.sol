// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/access/AccessControl.sol';
import '@openzeppelin/contracts/security/Pausable.sol';

contract Reputation is Ownable, AccessControl, Pausable {
    bytes32 public constant REWARD_ROLE = keccak256("REWARD_ROLE");
    
    struct PlayerProfile {
        uint256 xp;
        uint256 level;
        uint256 questCount;
        uint256 streak;
        uint256 onchainActions;
        uint256 lastQuestAt;
    }

    mapping(address => PlayerProfile) public profiles;

    event ReputationUpdated(address indexed player, uint256 xp, uint256 level, uint256 streak);
    event PlayerInitialized(address indexed player);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REWARD_ROLE, msg.sender);
    }

    function initializePlayer(address player) external whenNotPaused {
        require(player != address(0), 'Invalid player address');
        if (profiles[player].level == 0) {
            profiles[player] = PlayerProfile({
                xp: 0,
                level: 1,
                questCount: 0,
                streak: 0,
                onchainActions: 0,
                lastQuestAt: block.timestamp
            });
            emit PlayerInitialized(player);
        }
    }

    function rewardXP(address player, uint256 xpGain, uint256 actionCount) external onlyRole(REWARD_ROLE) whenNotPaused {
        require(player != address(0), 'Invalid player address');
        require(xpGain > 0, 'XP gain must be positive');
        
        PlayerProfile storage profile = profiles[player];
        require(profile.level > 0, 'Player not initialized');
        
        profile.xp += xpGain;
        profile.onchainActions += actionCount;
        profile.questCount += 1;
        
        if (block.timestamp - profile.lastQuestAt < 1 days) {
            profile.streak += 1;
        } else {
            profile.streak = 1;
        }
        
        profile.lastQuestAt = block.timestamp;
        profile.level = 1 + profile.xp / 1500;
        
        emit ReputationUpdated(player, profile.xp, profile.level, profile.streak);
    }

    function profileFor(address player) external view returns (PlayerProfile memory) {
        return profiles[player];
    }

    function grantRewardRole(address account) external onlyOwner {
        require(account != address(0), 'Invalid account');
        grantRole(REWARD_ROLE, account);
    }

    function revokeRewardRole(address account) external onlyOwner {
        revokeRole(REWARD_ROLE, account);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
