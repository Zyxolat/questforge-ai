// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./RewardNFT.sol";
import "./Reputation.sol";

interface ITreasury {
    function reserveReward(uint256 questId, address creator, uint256 rewardAmount) external;

    function settleQuestPayout(
        uint256 questId,
        address payable player,
        uint256 expectedRewardAmount
    ) external returns (uint256 totalPayout);

    function refundQuest(
        uint256 questId,
        address payable recipient,
        uint256 expectedRewardAmount,
        bytes32 reason
    ) external;

    function questFunds(uint256 questId) external view returns (uint256 reservedReward, address player, uint8 state);
}

contract ForgeQuestManager is ReentrancyGuard, Pausable, Ownable, AccessControl {
    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

    enum QuestStatus {
        Available,
        Accepted,
        Completed,
        Claimable,
        Rewarded,
        Cancelled
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
    uint256 public constant ACCEPTANCE_FEE = 0.001 ether;
    uint256 public constant MAX_QUEST_DURATION = 7 days;

    bool public rewardSystemHealthy = true;

    mapping(address => uint256) public playerNonces;
    mapping(bytes32 => bool) public usedProofHashes;
    mapping(bytes32 => uint256) public proofHashToQuestId;
    mapping(uint256 => Quest) public quests;
    mapping(address => uint256[]) public playerQuestIndices;

    uint256 public nextQuestId;
    RewardNFT public immutable rewardNFT;
    Reputation public immutable reputation;
    address public treasury;

    event QuestCreated(
        uint256 indexed questId,
        address indexed creator,
        string title,
        uint256 rewardAmount,
        uint256 xpReward
    );
    event QuestAccepted(
        uint256 indexed questId,
        address indexed player,
        uint256 acceptedAt
    );
    event QuestSubmitted(uint256 indexed questId, address indexed player, bytes32 proofHash);
    event QuestVerified(
        uint256 indexed questId,
        address indexed player,
        bool success,
        uint256 rewardAmount,
        uint256 xpReward,
        bytes32 proofHash
    );
    event QuestRewarded(
        uint256 indexed questId,
        address indexed player,
        uint256 rewardAmount,
        uint256 xpReward,
        bytes32 proofHash
    );
    event RewardClaimed(uint256 indexed questId, address indexed claimer, uint256 amount);
    event CircuitBreakerTriggered(string reason);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

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
        uint256 rewardAmount,
        uint256 xpReward,
        uint256 durationSeconds
    ) external payable whenNotPaused rewardSystemActive nonReentrant {
        require(bytes(title).length > 0, "Title required");
        require(bytes(metadataUri).length > 0, "Metadata required");
        // Creation of a quest does not collect the acceptance fee.
        // Acceptance is performed by a separate `acceptQuest` payable call.

        require(rewardAmount > 0, "Reward required");
        require(rewardAmount <= MAX_SINGLE_REWARD, "Reward exceeds maximum");
        require(xpReward > 0, "XP reward required");
        require(durationSeconds > 0, "Duration required");
        require(durationSeconds <= MAX_QUEST_DURATION, "Duration too long");

        uint256 questId = nextQuestId;
        nextQuestId += 1;

        // Record quest as AVAILABLE; acceptance happens separately.
        ITreasury(treasury).reserveReward(questId, msg.sender, rewardAmount);

        quests[questId] = Quest({
            questId: questId,
            creator: msg.sender,
            title: title,
            metadataUri: metadataUri,
            proofUri: "",
            proofHash: bytes32(0),
            stakeAmount: 0,
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

        playerQuestIndices[msg.sender].push(questId);
        reputation.initializePlayer(msg.sender);

        emit QuestCreated(questId, msg.sender, title, rewardAmount, xpReward);
    }

        function acceptQuest(uint256 questId) external payable whenNotPaused rewardSystemActive nonReentrant {
            require(msg.value == ACCEPTANCE_FEE, "Accept fee required");

            Quest storage quest = quests[questId];
            require(quest.questId != 0, "Quest not found");
            require(quest.status == QuestStatus.Available, "Quest unavailable");
            require(block.timestamp <= quest.expiresAt, "Quest expired");
            require(quest.player == address(0), "Quest already accepted");

            (bool success, ) = payable(treasury).call{value: msg.value}("");
            require(success, "Fee transfer failed");

            uint256 playerNonce = playerNonces[msg.sender];
            playerNonces[msg.sender] = playerNonce + 1;

            quest.player = msg.sender;
            quest.status = QuestStatus.Accepted;
            quest.startedAt = block.timestamp;
            quest.playerNonce = playerNonce;

            emit QuestAccepted(questId, msg.sender, block.timestamp);
        }

    /**
     * Atomic operation: Create and immediately accept a quest in a single transaction
     * 
     * This function is called by player wallets (not backend) when accepting a quest.
     * It creates a new quest and immediately marks it as accepted by the caller.
     * 
     * Requirements:
     * - msg.value == ACCEPTANCE_FEE (0.001 CELO)
     * - All quest parameters must be valid (same as createQuest)
     * 
     * Returns: The questId assigned to the newly created quest
     * 
     * Events:
     * - QuestCreated(questId, msg.sender, title, rewardAmount, xpReward)
     * - QuestAccepted(questId, msg.sender, block.timestamp)
     */
    function createAndAcceptQuest(
        string calldata title,
        string calldata metadataUri,
        uint256 rewardAmount,
        uint256 xpReward,
        uint256 durationSeconds
    ) external payable whenNotPaused rewardSystemActive nonReentrant 
        returns (uint256 questId) {
        
        // ===== CREATE PHASE =====
        
        // Validate acceptance fee is paid upfront
        require(msg.value == ACCEPTANCE_FEE, "Accept fee required");
        
        // Validate quest parameters (identical to createQuest())
        require(bytes(title).length > 0, "Title required");
        require(bytes(metadataUri).length > 0, "Metadata required");
        require(rewardAmount > 0, "Reward required");
        require(rewardAmount <= MAX_SINGLE_REWARD, "Reward exceeds maximum");
        require(xpReward > 0, "XP reward required");
        require(durationSeconds > 0, "Duration required");
        require(durationSeconds <= MAX_QUEST_DURATION, "Duration too long");
        
        // Allocate new quest ID
        questId = nextQuestId;
        nextQuestId += 1;
        
        // Reserve reward in treasury (before creating quest)
        ITreasury(treasury).reserveReward(questId, msg.sender, rewardAmount);
        
        // Create quest structure in Available status
        quests[questId] = Quest({
            questId: questId,
            creator: msg.sender,
            title: title,
            metadataUri: metadataUri,
            proofUri: "",
            proofHash: bytes32(0),
            stakeAmount: 0,
            rewardAmount: rewardAmount,
            xpReward: xpReward,
            createdAt: block.timestamp,
            startedAt: 0,           // Will be set during acceptance
            expiresAt: block.timestamp + durationSeconds,
            status: QuestStatus.Available,
            player: address(0),     // Will be set during acceptance
            playerNonce: 0,
            proofVerificationHash: bytes32(0)
        });
        
        // Register player quest index and initialize reputation
        playerQuestIndices[msg.sender].push(questId);
        reputation.initializePlayer(msg.sender);
        
        // Emit quest creation event
        emit QuestCreated(questId, msg.sender, title, rewardAmount, xpReward);
        
        // ===== ACCEPT PHASE =====
        
        // Transfer acceptance fee to treasury
        (bool success, ) = payable(treasury).call{value: msg.value}("");
        require(success, "Fee transfer failed");
        
        // Get player nonce for verification
        uint256 playerNonce = playerNonces[msg.sender];
        playerNonces[msg.sender] = playerNonce + 1;
        
        // Update quest status to ACCEPTED
        quests[questId].player = msg.sender;
        quests[questId].status = QuestStatus.Accepted;
        quests[questId].startedAt = block.timestamp;
        quests[questId].playerNonce = playerNonce;
        
        // Emit quest acceptance event
        emit QuestAccepted(questId, msg.sender, block.timestamp);
        
        return questId;
    }

    function submitQuest(uint256 questId, string calldata proofUri)
        external
        whenNotPaused
        rewardSystemActive
        onlyPlayer(questId)
    {
        Quest storage quest = quests[questId];
        require(quest.status == QuestStatus.Accepted, "Quest not accepted");
        require(block.timestamp <= quest.expiresAt, "Quest expired");
        require(bytes(proofUri).length > 0, "Proof required");
        require(bytes(proofUri).length <= 2048, "Proof URI too long");

        bytes32 proofHash = keccak256(bytes(proofUri));
        require(proofHash != bytes32(0), "Invalid proof");

        if (usedProofHashes[proofHash]) {
            require(proofHashToQuestId[proofHash] == questId, "Proof already submitted for different quest");
        }

        bytes32 verificationHash = keccak256(abi.encodePacked(msg.sender, proofUri, quest.playerNonce));

        quest.status = QuestStatus.Completed;
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
        require(quest.status == QuestStatus.Completed, "Quest not completed");
        require(quest.player != address(0), "Invalid quest");
        require(quest.proofVerificationHash != bytes32(0), "No proof hash set");
        require(quest.proofVerificationHash == proofVerificationHash, "Verification hash mismatch");

        if (success) {
            _completeQuest(questId, quest);
        } else {
            _failQuest(questId, quest);
        }
    }

    function claimReward(uint256 questId) external whenNotPaused nonReentrant rewardSystemActive {
        require(questId != 0, "Invalid quest ID");
        require(msg.sender != address(0), "Invalid sender");
        
        // Transfer 0.01 CELO to the player
        uint256 rewardAmount = 1e16; // 0.01 CELO (10^16 wei)
        
        // Check contract has sufficient balance
        require(
            address(this).balance >= rewardAmount,
            "Treasury insufficient balance"
        );
        
        // Transfer CELO to player
        (bool success, ) = payable(msg.sender).call{value: rewardAmount}("");
        require(success, "CELO transfer failed");
        
        // Emit event for tracking
        emit RewardClaimed(questId, msg.sender, rewardAmount);
    }

    function cancelQuest(uint256 questId) external whenNotPaused nonReentrant rewardSystemActive onlyPlayer(questId) {
        Quest storage quest = quests[questId];
        require(quest.questId != 0, "Quest not found");
        require(quest.status == QuestStatus.Accepted, "Quest not cancellable");
        require(quest.player != address(0), "Invalid quest");

        ITreasury(treasury).refundQuest(
            questId,
            payable(quest.player),
            quest.rewardAmount,
            keccak256(abi.encodePacked("QUEST_CANCELLED"))
        );

        quest.status = QuestStatus.Cancelled;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "Invalid treasury");

        address previousTreasury = treasury;
        treasury = newTreasury;

        emit TreasuryUpdated(previousTreasury, newTreasury);
    }

    function grantVerifier(address verifier) external onlyOwner {
        require(verifier != address(0), "Invalid verifier");
        _grantRole(VERIFIER_ROLE, verifier);
    }

    function revokeVerifier(address verifier) external onlyOwner {
        revokeRole(VERIFIER_ROLE, verifier);
    }

    function pauseRewardSystem() external onlyOwner {
        rewardSystemHealthy = false;
        emit CircuitBreakerTriggered("Reward system manually paused");
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
    /**
     * @dev Helper to safely extract a substring. Used for URI prefix validation
     *      to prevent arbitrary/malicious content from being used as NFT metadata.
     */
    function transferOwnership(address newOwner) public override onlyOwner {
        address previousOwner = owner();
        super.transferOwnership(newOwner);

        _grantRole(DEFAULT_ADMIN_ROLE, newOwner);
        _grantRole(VERIFIER_ROLE, newOwner);

        _revokeRole(VERIFIER_ROLE, previousOwner);
        _revokeRole(DEFAULT_ADMIN_ROLE, previousOwner);
    }

    function _completeQuest(uint256 questId, Quest storage quest) private {
        quest.status = QuestStatus.Claimable;

        emit QuestVerified(questId, quest.player, true, quest.rewardAmount, quest.xpReward, quest.proofHash);
    }

    function _failQuest(uint256 questId, Quest storage quest) private {
        ITreasury(treasury).refundQuest(
            questId,
            payable(quest.player),
            quest.rewardAmount,
            keccak256(abi.encodePacked("VERIFICATION_FAILED"))
        );

        quest.status = QuestStatus.Accepted;
        quest.proofUri = "";
        quest.proofHash = bytes32(0);
        quest.proofVerificationHash = bytes32(0);

        emit QuestVerified(questId, quest.player, false, quest.rewardAmount, quest.xpReward, quest.proofHash);
    }
}
