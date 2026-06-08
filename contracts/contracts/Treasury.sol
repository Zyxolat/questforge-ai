// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract Treasury is Ownable, AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant QUEST_MANAGER_ROLE = keccak256("QUEST_MANAGER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant WITHDRAW_ROLE = keccak256("WITHDRAW_ROLE");

    enum QuestFundState {
        None,
        Reserved,
        Paid,
        Refunded
    }

    struct QuestFund {
        uint256 reservedReward;
        address player;
        QuestFundState state;
    }

    uint256 public rewardReserveCap = 0.5 ether;
    uint256 public payoutCap = 0.5 ether;
    uint256 public totalReservedRewards;

    mapping(uint256 => QuestFund) public questFunds;

    event NativeRewardPoolFunded(address indexed funder, uint256 amount);
    event RewardReserved(
        uint256 indexed questId,
        address indexed creator,
        uint256 amount,
        uint256 totalReservedRewards
    );
    event RewardReleased(
        uint256 indexed questId,
        address indexed player,
        uint256 rewardAmount,
        uint256 totalPayout
    );
    event RewardPaid(
        uint256 indexed questId,
        address indexed player,
        uint256 rewardAmount,
        uint256 totalPayout
    );
    event RewardRefunded(
        uint256 indexed questId,
        address indexed recipient,
        uint256 rewardAmount,
        bytes32 reason
    );
    event EmergencyWithdrawal(
        address indexed operator,
        address indexed recipient,
        address indexed asset,
        uint256 amount
    );
    event CircuitBreakerTriggered(address indexed operator, string reason);
    event PayoutCapsUpdated(uint256 rewardReserveCap, uint256 payoutCap);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(GUARDIAN_ROLE, msg.sender);
        _grantRole(WITHDRAW_ROLE, msg.sender);
    }

    function reserveReward(
        uint256 questId,
        address creator,
        uint256 rewardAmount
    ) external onlyRole(QUEST_MANAGER_ROLE) whenNotPaused {
        require(questId != 0, "Invalid quest");
        require(creator != address(0), "Invalid creator");
        require(rewardAmount > 0, "Invalid reward amount");
        require(rewardAmount <= rewardReserveCap, "Reward reserve cap exceeded");

        QuestFund storage questFund = questFunds[questId];
        require(questFund.state == QuestFundState.None, "Reward already reserved");
        require(_hasRewardLiquidity(rewardAmount), "Insufficient treasury liquidity");

        questFund.reservedReward = rewardAmount;
        questFund.player = creator;
        questFund.state = QuestFundState.Reserved;

        totalReservedRewards += rewardAmount;

        emit RewardReserved(questId, creator, rewardAmount, totalReservedRewards);
    }

    function settleQuestPayout(
        uint256 questId,
        address payable player,
        uint256 expectedRewardAmount
    ) external onlyRole(QUEST_MANAGER_ROLE) whenNotPaused nonReentrant returns (uint256 totalPayout) {
        require(player != address(0), "Invalid player");

        QuestFund storage questFund = questFunds[questId];
        require(questFund.state == QuestFundState.Reserved, "Quest not payable");
        require(questFund.player == player, "Player mismatch");
        require(questFund.reservedReward == expectedRewardAmount, "Reward mismatch");

        totalPayout = expectedRewardAmount;
        require(totalPayout <= payoutCap, "Payout cap exceeded");
        require(isSolvent(), "Treasury insolvent");

        totalReservedRewards -= expectedRewardAmount;
        questFund.reservedReward = 0;
        questFund.player = address(0);
        questFund.state = QuestFundState.Paid;

        emit RewardReleased(questId, player, expectedRewardAmount, totalPayout);

        _safeNativeTransfer(player, totalPayout, "Payout transfer failed");

        emit RewardPaid(questId, player, expectedRewardAmount, totalPayout);
    }

    function refundQuest(
        uint256 questId,
        address payable recipient,
        uint256 expectedRewardAmount,
        bytes32 reason
    ) external onlyRole(QUEST_MANAGER_ROLE) nonReentrant returns (uint256 refundedStakeAmount) {
        QuestFund storage questFund = questFunds[questId];
        require(questFund.state == QuestFundState.Reserved, "Quest not refundable");
        require(questFund.reservedReward == expectedRewardAmount, "Reward mismatch");

        totalReservedRewards -= expectedRewardAmount;
        questFund.reservedReward = 0;
        questFund.player = address(0);
        questFund.state = QuestFundState.Refunded;

        refundedStakeAmount = 0;

        emit RewardRefunded(questId, recipient, expectedRewardAmount, reason);
    }

    function fundNativeRewardPool() external payable onlyOwner whenNotPaused {
        require(msg.value > 0, "Invalid fund amount");
        emit NativeRewardPoolFunded(msg.sender, msg.value);
    }

    function setPayoutCaps(
        uint256 newRewardReserveCap,
        uint256 newPayoutCap
    ) external onlyOwner {
        require(newRewardReserveCap > 0, "Invalid reward cap");
        require(newPayoutCap >= newRewardReserveCap, "Invalid payout cap");

        rewardReserveCap = newRewardReserveCap;
        payoutCap = newPayoutCap;

        emit PayoutCapsUpdated(newRewardReserveCap, newPayoutCap);
    }

    function tripCircuitBreaker(string calldata reason) external onlyRole(GUARDIAN_ROLE) {
        _pause();
        emit CircuitBreakerTriggered(msg.sender, reason);
    }

    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function emergencyWithdrawNative(address payable recipient, uint256 amount)
        external
        onlyRole(WITHDRAW_ROLE)
        whenPaused
        nonReentrant
    {
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Invalid withdrawal amount");
        require(availableNativeWithdrawalBalance() >= amount, "Insufficient surplus balance");

        _safeNativeTransfer(recipient, amount, "Emergency withdrawal failed");

        emit EmergencyWithdrawal(msg.sender, recipient, address(0), amount);
    }

    function obligations() public view returns (uint256) {
        return totalReservedRewards;
    }

    function isSolvent() public view returns (bool) {
        return address(this).balance >= obligations();
    }

    function availableRewardLiquidity() public view returns (uint256) {
        if (address(this).balance <= obligations()) {
            return 0;
        }

        return address(this).balance - obligations();
    }

    function availableNativeWithdrawalBalance() public view returns (uint256) {
        return availableRewardLiquidity();
    }

    function supportsInterface(bytes4 interfaceId) public view override(AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function transferOwnership(address newOwner) public override onlyOwner {
        address previousOwner = owner();
        super.transferOwnership(newOwner);

        _grantRole(DEFAULT_ADMIN_ROLE, newOwner);
        _grantRole(GUARDIAN_ROLE, newOwner);
        _grantRole(WITHDRAW_ROLE, newOwner);

        _revokeRole(GUARDIAN_ROLE, previousOwner);
        _revokeRole(WITHDRAW_ROLE, previousOwner);
        _revokeRole(DEFAULT_ADMIN_ROLE, previousOwner);
    }

    function _hasRewardLiquidity(uint256 rewardAmount) private view returns (bool) {
        return address(this).balance >= obligations() + rewardAmount;
    }

    function _safeNativeTransfer(
        address payable recipient,
        uint256 amount,
        string memory errorMessage
    ) private {
        (bool success, ) = recipient.call{value: amount}("");
        require(success, errorMessage);
    }

    receive() external payable {
        emit NativeRewardPoolFunded(msg.sender, msg.value);
    }
}
