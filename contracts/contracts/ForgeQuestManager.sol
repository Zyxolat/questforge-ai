// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./RewardNFT.sol";
import "./Reputation.sol";

contract ForgeQuestManager is ReentrancyGuard, Pausable, Ownable, AccessControl {
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    enum QuestStatus {
        Available,
        Active,
        Submitted,
        Verified,
        Cancelled,
        Failed
    }

    struct Quest {
        uint256 questId;
        address creator;
        string title;
        string metadataUri;
        string proofUri;
        bytes32 proofHash;
        uint256 stakeAmount;
        uint256 rewardAmount;
        uint256 xpReward;
        uint256 createdAt;
        uint256 startedAt;
        uint256 expiresAt;
        QuestStatus status;
        address player;
        uint256 playerNonce;
        bytes32 proofVerificationHash;
    }

    uint256 public constant MAX_SINGLE_REWARD = 0.5 ether;
    uint256 public constant MAX_SINGLE_STAKE = 10 ether;
    uint256 public constant MIN_SINGLE_STAKE = 0.001 ether;
    uint256 public constant MAX_QUEST_DURATION = 7 days;

    bool public rewardSystemHealthy = true;
    uint256 public totalRewardsDistributed;
    uint256 public maxRewardPoolSize = 1000 ether;

    mapping(address => uint256) public playerNonces;
    mapping(bytes32 => bool) public usedProofHashes;
    mapping(bytes32 => uint256) public proofHashToQuestId;
    mapping(uint256 => Quest) public quests;
    mapping(address => uint256[]) public playerQuestIndices;

    uint256 public nextQuestId;
    RewardNFT public immutable rewardNFT;
    Reputation public immutable reputation;
    address public treasury;

    event QuestCreated(uint256 indexed questId, address indexed creator, string title, uint256 rewardAmount, uint256 xpReward);
    event QuestStarted(uint256 indexed questId, address indexed creator, address indexed player, uint256 stakeAmount);
    event QuestSubmitted(uint256 indexed questId, address indexed player, bytes32 proofHash);
    event QuestVerified(uint256 indexed questId, address indexed player, bool success, uint256 rewardAmount, uint256 xpReward, bytes32 proofHash);
    event QuestCancelled(uint256 indexed questId);
    event CircuitBreakerTriggered(string reason);

    modifier onlyPlayer(uint256 questId) {
        require(quests[questId].player == msg.sender, "Not quest player");
        _;
    }

    modifier onlyVerifier() {
        require(hasRole(VERIFIER_ROLE, msg.sender), "Verifier role required");
        _;
    }

    modifier rewardSystemActive() {
        require(rewardSystemHealthy, "Reward system is paused");
        _;
    }

    constructor(address rewardNFTAddress, address reputationAddress, address treasuryAddress) {
        require(rewardNFTAddress != address(0), "Invalid NFT address");
        require(reputationAddress != address(0), "Invalid Reputation address");
        require(treasuryAddress != address(0), "Invalid Treasury address");

        rewardNFT = RewardNFT(rewardNFTAddress);
        reputation = Reputation(reputationAddress);
        treasury = treasuryAddress;
        nextQuestId = 1;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(VERIFIER_ROLE, msg.sender);
    }

    function createQuest(
        string calldata title,
        string calldata metadataUri,
        uint256 stakeAmount,
        uint256 rewardAmount,
        uint256 xpReward,
        uint256 durationSeconds
    ) external whenNotPaused rewardSystemActive {
        require(bytes(title).length > 0, "Title required");
        require(bytes(metadataUri).length > 0, "Metadata required");
        require(stakeAmount >= MIN_SINGLE_STAKE, "Stake too small");
        require(stakeAmount <= MAX_SINGLE_STAKE, "Stake exceeds maximum");
        require(rewardAmount > 0, "Reward required");
        require(rewardAmount <= MAX_SINGLE_REWARD, "Reward exceeds maximum");
        require(xpReward > 0, "XP reward required");
        require(durationSeconds > 0, "Duration required");
        require(durationSeconds <= MAX_QUEST_DURATION, "Duration too long");

        _ensureRewardPoolCapacity(rewardAmount);

        uint256 questId = nextQuestId;
        nextQuestId += 1;

        quests[questId] = Quest({
            questId: questId,
            creator: msg.sender,
            title: title,
            metadataUri: metadataUri,
            proofUri: "",
            proofHash: bytes32(0),
            stakeAmount: stakeAmount,
            rewardAmount: rewardAmount,
            xpReward: xpReward,
            createdAt: block.timestamp,
            startedAt: 0,
            expiresAt: block.timestamp + durationSeconds,
            status: QuestStatus.Available,
            player: address(0),
            playerNonce: 0,
            proofVerificationHash: bytes32(0)
        });

        emit QuestCreated(questId, msg.sender, title, rewardAmount, xpReward);
    }

    function startQuest(uint256 questId) external payable nonReentrant whenNotPaused {
        Quest storage quest = quests[questId];
        require(quest.questId != 0, "Quest not found");
        require(quest.status == QuestStatus.Available, "Quest unavailable");
        require(block.timestamp <= quest.expiresAt, "Quest expired");
        require(msg.value == quest.stakeAmount, "Incorrect stake amount");

        uint256 playerNonce = playerNonces[msg.sender];
        playerNonces[msg.sender] = playerNonce + 1;

        quest.player = msg.sender;
        quest.status = QuestStatus.Active;
        quest.startedAt = block.timestamp;
        quest.playerNonce = playerNonce;

        playerQuestIndices[msg.sender].push(questId);
        reputation.initializePlayer(msg.sender);

        emit QuestStarted(questId, quest.creator, msg.sender, quest.stakeAmount);
    }

    function submitQuest(uint256 questId, string calldata proofUri) external whenNotPaused onlyPlayer(questId) {
        Quest storage quest = quests[questId];
        require(quest.status == QuestStatus.Active, "Quest not active");
        require(block.timestamp <= quest.expiresAt, "Quest expired");
        require(bytes(proofUri).length > 0, "Proof required");
        require(bytes(proofUri).length <= 2048, "Proof URI too long");

        bytes32 proofHash = keccak256(bytes(proofUri));
        require(proofHash != bytes32(0), "Invalid proof");

        if (usedProofHashes[proofHash]) {
            require(proofHashToQuestId[proofHash] == questId, "Proof already submitted for different quest");
        }

        bytes32 verificationHash = keccak256(abi.encodePacked(msg.sender, proofUri, quest.playerNonce));

        quest.status = QuestStatus.Submitted;
        quest.proofUri = proofUri;
        quest.proofHash = proofHash;
        quest.proofVerificationHash = verificationHash;

        usedProofHashes[proofHash] = true;
        proofHashToQuestId[proofHash] = questId;

        emit QuestSubmitted(questId, msg.sender, proofHash);
    }

    function verifyQuest(
        uint256 questId,
        bool success,
        bytes32 proofVerificationHash
    ) external whenNotPaused nonReentrant rewardSystemActive onlyVerifier {
        Quest storage quest = quests[questId];
        require(quest.questId != 0, "Quest not found");
        require(quest.status == QuestStatus.Submitted, "Not submitted");
        require(quest.player != address(0), "Invalid quest");
        require(quest.proofVerificationHash != bytes32(0), "No proof hash set");
        require(quest.proofVerificationHash == proofVerificationHash, "Verification hash mismatch");

        if (success) {
            _completeQuest(questId, quest);
        } else {
            _failQuest(questId, quest);
        }
    }

    function cancelQuest(uint256 questId) external whenNotPaused nonReentrant {
        Quest storage quest = quests[questId];
        require(quest.questId != 0, "Quest not found");
        require(
            quest.status == QuestStatus.Available || quest.status == QuestStatus.Active,
            "Cannot cancel"
        );
        require(
            msg.sender == owner() || msg.sender == quest.creator || msg.sender == quest.player,
            "Unauthorized"
        );

        if (quest.status == QuestStatus.Active && quest.player != address(0)) {
            _safeNativeTransfer(quest.player, quest.stakeAmount, "Refund failed");
        }

        quest.status = QuestStatus.Cancelled;
        emit QuestCancelled(questId);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury");
        treasury = newTreasury;
    }

    function grantVerifier(address verifier) external onlyOwner {
        require(verifier != address(0), "Invalid verifier");
        _grantRole(VERIFIER_ROLE, verifier);
    }

    function revokeVerifier(address verifier) external onlyOwner {
        revokeRole(VERIFIER_ROLE, verifier);
    }

    function setMaxRewardPoolSize(uint256 newMax) external onlyOwner {
        require(newMax > 0, "Invalid max");
        maxRewardPoolSize = newMax;
    }

    function pauseRewardSystem() external onlyOwner {
        rewardSystemHealthy = false;
    }

    function unpauseRewardSystem() external onlyOwner {
        rewardSystemHealthy = true;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function supportsInterface(bytes4 interfaceId) public view override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _completeQuest(uint256 questId, Quest storage quest) private {
        require(quest.rewardAmount <= MAX_SINGLE_REWARD, "Reward exceeds maximum");
        require(quest.stakeAmount <= MAX_SINGLE_STAKE, "Stake exceeds maximum");

        uint256 totalPayout = quest.stakeAmount + quest.rewardAmount;
        require(address(this).balance >= totalPayout, "Insufficient reward reserve");

        totalRewardsDistributed += quest.rewardAmount;
        if (totalRewardsDistributed >= maxRewardPoolSize) {
            rewardSystemHealthy = false;
            emit CircuitBreakerTriggered("Reward pool exhausted");
        }

        quest.status = QuestStatus.Verified;

        string memory rewardMetadataUri = bytes(quest.proofUri).length > 0 ? quest.proofUri : quest.metadataUri;
        rewardNFT.mintQuestReward(quest.player, questId, rewardMetadataUri);
        reputation.rewardXP(quest.player, quest.xpReward, 1);
        _safeNativeTransfer(quest.player, totalPayout, "Transfer failed");

        emit QuestVerified(questId, quest.player, true, quest.rewardAmount, quest.xpReward, quest.proofHash);
    }

    function _failQuest(uint256 questId, Quest storage quest) private {
        quest.status = QuestStatus.Failed;
        _safeNativeTransfer(treasury, quest.stakeAmount, "Treasury transfer failed");
        emit QuestVerified(questId, quest.player, false, quest.rewardAmount, quest.xpReward, quest.proofHash);
    }

    function _ensureRewardPoolCapacity(uint256 pendingReward) private view {
        require(totalRewardsDistributed + pendingReward <= maxRewardPoolSize, "Reward system paused");
    }

    function _safeNativeTransfer(address recipient, uint256 amount, string memory errorMessage) private {
        (bool success, ) = payable(recipient).call{value: amount}("");
        require(success, errorMessage);
    }

    receive() external payable {}
}
