// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract Treasury is Ownable, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant QUEST_MANAGER_ROLE = keccak256("QUEST_MANAGER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant WITHDRAW_ROLE = keccak256("WITHDRAW_ROLE");

    enum QuestFundState {
        None,
        Reserved,
        Locked,
        Paid,
        Refunded
    }

    struct QuestFund {
        uint256 reservedReward;
        uint256 lockedStake;
        address player;
        QuestFundState state;
    }

    IERC20 public immutable rewardToken;

    uint256 public rewardReserveCap = 0.5 ether;
    uint256 public stakeLockCap = 10 ether;
    uint256 public payoutCap = 10.5 ether;
    uint256 public totalReservedRewards;
    uint256 public totalLockedStakes;

    mapping(uint256 => QuestFund) public questFunds;

    event NativeRewardPoolFunded(address indexed funder, uint256 amount);
    event RewardTokenPoolFunded(address indexed funder, uint256 amount);
    event RewardReserved(
        uint256 indexed questId,
        address indexed creator,
        uint256 amount,
        uint256 totalReservedRewards
    );
    event StakeLocked(
        uint256 indexed questId,
        address indexed player,
        uint256 amount,
        uint256 totalLockedStakes
    );
    event RewardReleased(
        uint256 indexed questId,
        address indexed player,
        uint256 rewardAmount,
        uint256 stakeAmount,
        uint256 totalPayout
    );
    event RewardPaid(
        uint256 indexed questId,
        address indexed player,
        uint256 rewardAmount,
        uint256 stakeAmount,
        uint256 totalPayout
    );
    event RewardRefunded(
        uint256 indexed questId,
        address indexed recipient,
        uint256 rewardAmount,
        uint256 stakeAmount,
        bytes32 reason
    );
    event EmergencyWithdrawal(
        address indexed operator,
        address indexed recipient,
        address indexed asset,
        uint256 amount
    );
    event CircuitBreakerTriggered(address indexed operator, string reason);
    event PayoutCapsUpdated(uint256 rewardReserveCap, uint256 stakeLockCap, uint256 payoutCap);

    constructor(address tokenAddress) {
        require(tokenAddress != address(0), "Invalid token address");

        rewardToken = IERC20(tokenAddress);

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
        questFund.state = QuestFundState.Reserved;

        totalReservedRewards += rewardAmount;

        emit RewardReserved(questId, creator, rewardAmount, totalReservedRewards);
    }

    function lockStake(
        uint256 questId,
        address player,
        uint256 expectedStakeAmount
    ) external payable onlyRole(QUEST_MANAGER_ROLE) whenNotPaused {
        require(questId != 0, "Invalid quest");
        require(player != address(0), "Invalid player");
        require(expectedStakeAmount > 0, "Invalid stake amount");
        require(expectedStakeAmount <= stakeLockCap, "Stake lock cap exceeded");
        require(msg.value == expectedStakeAmount, "Incorrect stake amount");

        QuestFund storage questFund = questFunds[questId];
        require(questFund.state == QuestFundState.Reserved, "Quest not reservable");
        require(questFund.player == address(0), "Stake already locked");

        questFund.player = player;
        questFund.lockedStake = expectedStakeAmount;
        questFund.state = QuestFundState.Locked;

        totalLockedStakes += expectedStakeAmount;

        emit StakeLocked(questId, player, expectedStakeAmount, totalLockedStakes);
    }

    function settleQuestPayout(
        uint256 questId,
        address payable player,
        uint256 expectedRewardAmount,
        uint256 expectedStakeAmount
    ) external onlyRole(QUEST_MANAGER_ROLE) whenNotPaused nonReentrant returns (uint256 totalPayout) {
        require(player != address(0), "Invalid player");

        QuestFund storage questFund = questFunds[questId];
        require(questFund.state == QuestFundState.Locked, "Quest not payable");
        require(questFund.player == player, "Player mismatch");
        require(questFund.reservedReward == expectedRewardAmount, "Reward mismatch");
        require(questFund.lockedStake == expectedStakeAmount, "Stake mismatch");

        totalPayout = expectedRewardAmount + expectedStakeAmount;
        require(totalPayout <= payoutCap, "Payout cap exceeded");
        require(isSolvent(), "Treasury insolvent");

        totalReservedRewards -= expectedRewardAmount;
        totalLockedStakes -= expectedStakeAmount;
        questFund.state = QuestFundState.Paid;

        emit RewardReleased(questId, player, expectedRewardAmount, expectedStakeAmount, totalPayout);

        _safeNativeTransfer(player, totalPayout, "Payout transfer failed");

        emit RewardPaid(questId, player, expectedRewardAmount, expectedStakeAmount, totalPayout);
    }

    function refundQuest(
        uint256 questId,
        address payable recipient,
        uint256 expectedRewardAmount,
        uint256 expectedStakeAmount,
        bytes32 reason
    ) external onlyRole(QUEST_MANAGER_ROLE) nonReentrant returns (uint256 refundedStakeAmount) {
        QuestFund storage questFund = questFunds[questId];
        require(
            questFund.state == QuestFundState.Reserved || questFund.state == QuestFundState.Locked,
            "Quest not refundable"
        );
        require(questFund.reservedReward == expectedRewardAmount, "Reward mismatch");
        require(questFund.lockedStake == expectedStakeAmount, "Stake mismatch");

        if (expectedStakeAmount > 0) {
            require(recipient != address(0), "Invalid recipient");
            require(questFund.player == recipient, "Player mismatch");
        }

        totalReservedRewards -= expectedRewardAmount;

        if (expectedStakeAmount > 0) {
            totalLockedStakes -= expectedStakeAmount;
        }

        questFund.state = QuestFundState.Refunded;
        refundedStakeAmount = expectedStakeAmount;

        if (refundedStakeAmount > 0) {
            _safeNativeTransfer(recipient, refundedStakeAmount, "Refund transfer failed");
        }

        emit RewardRefunded(questId, recipient, expectedRewardAmount, expectedStakeAmount, reason);
    }

    function fundNativeRewardPool() external payable onlyOwner whenNotPaused {
        require(msg.value > 0, "Invalid fund amount");
        emit NativeRewardPoolFunded(msg.sender, msg.value);
    }

    function fundRewardTokenPool(uint256 amount) external onlyOwner whenNotPaused {
        require(amount > 0, "Invalid fund amount");
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardTokenPoolFunded(msg.sender, amount);
    }

    function setPayoutCaps(
        uint256 newRewardReserveCap,
        uint256 newStakeLockCap,
        uint256 newPayoutCap
    ) external onlyOwner {
        require(newRewardReserveCap > 0, "Invalid reward cap");
        require(newStakeLockCap > 0, "Invalid stake cap");
        require(newPayoutCap >= newRewardReserveCap + newStakeLockCap, "Invalid payout cap");

        rewardReserveCap = newRewardReserveCap;
        stakeLockCap = newStakeLockCap;
        payoutCap = newPayoutCap;

        emit PayoutCapsUpdated(newRewardReserveCap, newStakeLockCap, newPayoutCap);
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

    function emergencyWithdrawRewardToken(address recipient, uint256 amount)
        external
        onlyRole(WITHDRAW_ROLE)
        whenPaused
        nonReentrant
    {
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Invalid withdrawal amount");

        rewardToken.safeTransfer(recipient, amount);

        emit EmergencyWithdrawal(msg.sender, recipient, address(rewardToken), amount);
    }

    function obligations() public view returns (uint256) {
        return totalReservedRewards + totalLockedStakes;
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
