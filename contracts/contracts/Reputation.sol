// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/security/Pausable.sol';

contract Reputation is Ownable, Pausable {
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

    function initializePlayer(address player) external whenNotPaused {
        if (profiles[player].level == 0) {
            profiles[player] = PlayerProfile({
                xp: 0,
                level: 1,
                questCount: 0,
                streak: 0,
                onchainActions: 0,
                lastQuestAt: block.timestamp
            });
        }
    }

    function rewardXP(address player, uint256 xpGain, uint256 actionCount) external onlyOwner whenNotPaused {
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

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
