// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import '@openzeppelin/contracts/security/ReentrancyGuard.sol';
import '@openzeppelin/contracts/security/Pausable.sol';
import '@openzeppelin/contracts/access/Ownable.sol';
import './RewardNFT.sol';

contract ForgeQuestManager is ReentrancyGuard, Pausable, Ownable {
    enum QuestStatus { Available, Active, Submitted, Verified, Cancelled }

    struct Quest {
        uint256 questId;
        address creator;
        string title;
        string metadataUri;
        uint256 stakeAmount;
        uint256 rewardAmount;
        uint256 expiresAt;
        QuestStatus status;
        address player;
    }

    mapping(uint256 => Quest) public quests;
    mapping(address => uint256[]) public playerQuestIndices;
    uint256 public nextQuestId;
    RewardNFT public rewardNFT;
    address public treasury;

    event QuestCreated(uint256 indexed questId, address indexed creator, string title, uint256 rewardAmount);
    event QuestStarted(uint256 indexed questId, address indexed player);
    event QuestSubmitted(uint256 indexed questId, address indexed player);
    event QuestVerified(uint256 indexed questId, address indexed player, bool success);
    event QuestCancelled(uint256 indexed questId);

    modifier onlyPlayer(uint256 questId) {
        require(quests[questId].player == msg.sender, 'Not quest player');
        _;
    }

    constructor(address rewardNFTAddress, address treasuryAddress) {
        rewardNFT = RewardNFT(rewardNFTAddress);
        treasury = treasuryAddress;
        nextQuestId = 1;
    }

    function createQuest(string calldata title, string calldata metadataUri, uint256 stakeAmount, uint256 rewardAmount, uint256 durationSeconds) external whenNotPaused {
        require(rewardAmount > 0, 'Reward required');
        uint256 questId = nextQuestId++;
        quests[questId] = Quest({
            questId: questId,
            creator: msg.sender,
            title: title,
            metadataUri: metadataUri,
            stakeAmount: stakeAmount,
            rewardAmount: rewardAmount,
            expiresAt: block.timestamp + durationSeconds,
            status: QuestStatus.Available,
            player: address(0)
        });
        emit QuestCreated(questId, msg.sender, title, rewardAmount);
    }

    function startQuest(uint256 questId) external payable nonReentrant whenNotPaused {
        Quest storage quest = quests[questId];
        require(quest.status == QuestStatus.Available, 'Quest unavailable');
        require(msg.value == quest.stakeAmount, 'Incorrect stake');
        quest.player = msg.sender;
        quest.status = QuestStatus.Active;
        playerQuestIndices[msg.sender].push(questId);
        emit QuestStarted(questId, msg.sender);
    }

    function submitQuest(uint256 questId, string calldata proofUri) external whenNotPaused onlyPlayer(questId) {
        Quest storage quest = quests[questId];
        require(quest.status == QuestStatus.Active, 'Quest not active');
        require(block.timestamp <= quest.expiresAt, 'Quest expired');
        quest.status = QuestStatus.Submitted;
        quest.metadataUri = proofUri;
        emit QuestSubmitted(questId, msg.sender);
    }

    function verifyQuest(uint256 questId, bool success) external onlyOwner whenNotPaused nonReentrant {
        Quest storage quest = quests[questId];
        require(quest.status == QuestStatus.Submitted, 'Not submitted');
        if (success) {
            quest.status = QuestStatus.Verified;
            payable(quest.player).transfer(quest.stakeAmount + quest.rewardAmount);
            rewardNFT.mintQuestReward(quest.player, questId, quest.metadataUri);
        } else {
            quest.status = QuestStatus.Cancelled;
            payable(treasury).transfer(quest.stakeAmount);
        }
        emit QuestVerified(questId, quest.player, success);
    }

    function cancelQuest(uint256 questId) external whenNotPaused {
        Quest storage quest = quests[questId];
        require(quest.status == QuestStatus.Available || quest.status == QuestStatus.Active, 'Cannot cancel');
        require(msg.sender == owner() || msg.sender == quest.creator || msg.sender == quest.player, 'Unauthorized');
        if (quest.status == QuestStatus.Active) {
            payable(quest.player).transfer(quest.stakeAmount);
        }
        quest.status = QuestStatus.Cancelled;
        emit QuestCancelled(questId);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        treasury = newTreasury;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
