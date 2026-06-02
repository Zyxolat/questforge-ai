import { expect } from 'chai';
import hre from 'hardhat';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import {
  Treasury__factory,
  type Treasury,
} from '../typechain-types';

const { ethers } = hre;

describe('Treasury', function () {
  let treasury: Treasury;
  let owner: SignerWithAddress;
  let questManager: SignerWithAddress;
  let guardian: SignerWithAddress;
  let player: SignerWithAddress;
  let other: SignerWithAddress;

  const reward = ethers.parseEther('0.03');
  const stake = ethers.parseEther('0.01');

  beforeEach(async function () {
    [owner, questManager, guardian, player, other] = await ethers.getSigners();

    const TreasuryFactory = new Treasury__factory(owner);
    treasury = await TreasuryFactory.deploy();
    await treasury.waitForDeployment();

    const questManagerRole = await treasury.QUEST_MANAGER_ROLE();
    const guardianRole = await treasury.GUARDIAN_ROLE();

    await treasury.grantRole(questManagerRole, questManager.address);
    await treasury.grantRole(guardianRole, guardian.address);
    await treasury.fundNativeRewardPool({ value: ethers.parseEther('1') });
  });

  describe('deployment', function () {
    it('starts solvent with native CELO reward liquidity', async function () {
      expect(await treasury.isSolvent()).to.equal(true);
      expect(await ethers.provider.getBalance(await treasury.getAddress())).to.equal(ethers.parseEther('1'));
    });
  });

  describe('reward reservation accounting', function () {
    it('reserves rewards and updates native liquidity', async function () {
      await expect(treasury.connect(questManager).reserveReward(1, owner.address, reward))
        .to.emit(treasury, 'RewardReserved')
        .withArgs(1, owner.address, reward, reward);

      const questFund = await treasury.questFunds(1);
      expect(questFund.reservedReward).to.equal(reward);
      expect(questFund.lockedStake).to.equal(0);
      expect(questFund.player).to.equal(ethers.ZeroAddress);
      expect(questFund.state).to.equal(1);
      expect(await treasury.totalReservedRewards()).to.equal(reward);
      expect(await treasury.availableRewardLiquidity()).to.equal(ethers.parseEther('0.97'));
    });

    it('rejects reservations beyond available treasury liquidity', async function () {
      await treasury.setPayoutCaps(ethers.parseEther('0.8'), ethers.parseEther('10'), ethers.parseEther('10.8'));
      await treasury.connect(questManager).reserveReward(1, owner.address, ethers.parseEther('0.8'));

      await expect(
        treasury.connect(questManager).reserveReward(2, owner.address, ethers.parseEther('0.3'))
      ).to.be.revertedWith('Insufficient treasury liquidity');
    });

    it('prevents duplicate reward reservations', async function () {
      await treasury.connect(questManager).reserveReward(1, owner.address, reward);

      await expect(
        treasury.connect(questManager).reserveReward(1, owner.address, reward)
      ).to.be.revertedWith('Reward already reserved');
    });
  });

  describe('stake locking and settlement lifecycle', function () {
    beforeEach(async function () {
      await treasury.connect(questManager).reserveReward(1, owner.address, reward);
    });

    it('locks the player stake under the reserved quest record', async function () {
      await expect(
        treasury.connect(questManager).lockStake(1, player.address, stake, { value: stake })
      ).to.emit(treasury, 'StakeLocked');

      const questFund = await treasury.questFunds(1);
      expect(questFund.lockedStake).to.equal(stake);
      expect(questFund.player).to.equal(player.address);
      expect(questFund.state).to.equal(2);
      expect(await treasury.totalLockedStakes()).to.equal(stake);
    });

    it('requires the exact native stake amount to be locked', async function () {
      await expect(
        treasury.connect(questManager).lockStake(1, player.address, stake, { value: reward })
      ).to.be.revertedWith('Incorrect stake amount');
    });

    it('settles a payout through treasury and clears reserved accounting', async function () {
      await treasury.connect(questManager).lockStake(1, player.address, stake, { value: stake });

      const treasuryBalanceBefore = await ethers.provider.getBalance(await treasury.getAddress());
      const playerBalanceBefore = await ethers.provider.getBalance(player.address);

      await expect(
        treasury.connect(questManager).settleQuestPayout(1, player.address, reward, stake)
      )
        .to.emit(treasury, 'RewardReleased')
        .withArgs(1, player.address, reward, stake, reward + stake);

      const treasuryBalanceAfter = await ethers.provider.getBalance(await treasury.getAddress());
      const playerBalanceAfter = await ethers.provider.getBalance(player.address);
      const questFund = await treasury.questFunds(1);

      expect(playerBalanceAfter - playerBalanceBefore).to.equal(reward + stake);
      expect(treasuryBalanceBefore - treasuryBalanceAfter).to.equal(reward + stake);
      expect(await treasury.totalReservedRewards()).to.equal(0);
      expect(await treasury.totalLockedStakes()).to.equal(0);
      expect(questFund.state).to.equal(3);
      expect(await treasury.isSolvent()).to.equal(true);
    });

    it('prevents double payouts for the same quest', async function () {
      await treasury.connect(questManager).lockStake(1, player.address, stake, { value: stake });
      await treasury.connect(questManager).settleQuestPayout(1, player.address, reward, stake);

      await expect(
        treasury.connect(questManager).settleQuestPayout(1, player.address, reward, stake)
      ).to.be.revertedWith('Quest not payable');
    });

    it('refunds locked stake and reward reservation on failure or cancel', async function () {
      await treasury.connect(questManager).lockStake(1, player.address, stake, { value: stake });
      const playerBalanceBefore = await ethers.provider.getBalance(player.address);

      await expect(
        treasury
          .connect(questManager)
          .refundQuest(1, player.address, reward, stake, ethers.keccak256(ethers.toUtf8Bytes('QUEST_FAILED')))
      )
        .to.emit(treasury, 'RewardRefunded')
        .withArgs(
          1,
          player.address,
          reward,
          stake,
          ethers.keccak256(ethers.toUtf8Bytes('QUEST_FAILED'))
        );

      const playerBalanceAfter = await ethers.provider.getBalance(player.address);
      const questFund = await treasury.questFunds(1);

      expect(playerBalanceAfter - playerBalanceBefore).to.equal(stake);
      expect(await treasury.totalReservedRewards()).to.equal(0);
      expect(await treasury.totalLockedStakes()).to.equal(0);
      expect(questFund.state).to.equal(4);
    });
  });

  describe('permissions and circuit breaker controls', function () {
    it('rejects unauthorized payout operations', async function () {
      await expect(treasury.connect(other).reserveReward(1, owner.address, reward)).to.be.reverted;
      await treasury.connect(questManager).reserveReward(1, owner.address, reward);

      await expect(
        treasury.connect(other).lockStake(1, player.address, stake, { value: stake })
      ).to.be.reverted;
      await treasury.connect(questManager).lockStake(1, player.address, stake, { value: stake });

      await expect(
        treasury.connect(other).settleQuestPayout(1, player.address, reward, stake)
      ).to.be.reverted;
    });

    it('pauses new reserve/lock/settle actions through the guardian role', async function () {
      await treasury.connect(questManager).reserveReward(1, owner.address, reward);
      await treasury.connect(guardian).pause();

      await expect(
        treasury.connect(questManager).reserveReward(2, owner.address, reward)
      ).to.be.revertedWith('Pausable: paused');
      await expect(
        treasury.connect(questManager).lockStake(1, player.address, stake, { value: stake })
      ).to.be.revertedWith('Pausable: paused');
      await expect(
        treasury.connect(questManager).settleQuestPayout(1, player.address, reward, stake)
      ).to.be.revertedWith('Pausable: paused');

      await treasury.unpause();
      await expect(
        treasury.connect(questManager).lockStake(1, player.address, stake, { value: stake })
      ).to.not.be.reverted;
    });

    it('supports a circuit breaker and surplus-only native emergency withdrawals', async function () {
      await treasury.connect(questManager).reserveReward(1, owner.address, reward);
      await treasury.connect(guardian).tripCircuitBreaker('suspicious activity');

      await expect(
        treasury.emergencyWithdrawNative(other.address, ethers.parseEther('0.98'))
      ).to.be.revertedWith('Insufficient surplus balance');

      const recipientBalanceBefore = await ethers.provider.getBalance(other.address);
      await treasury.emergencyWithdrawNative(other.address, ethers.parseEther('0.5'));
      const recipientBalanceAfter = await ethers.provider.getBalance(other.address);

      expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(ethers.parseEther('0.5'));
      expect(await treasury.totalReservedRewards()).to.equal(reward);
      expect(await treasury.isSolvent()).to.equal(true);
    });

    it('does not expose ERC20 reward-token funding on the CELO-only treasury', async function () {
      expect('fundRewardTokenPool' in treasury).to.equal(false);
      expect('emergencyWithdrawRewardToken' in treasury).to.equal(false);
    });
  });
});
