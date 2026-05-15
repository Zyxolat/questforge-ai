import { expect } from 'chai';
import hre from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { Reputation__factory, type Reputation } from '../typechain-types';

const { ethers } = hre;

async function expectRevert(txPromise: Promise<unknown>, message?: string) {
  try {
    await txPromise;
    expect.fail('Expected transaction to revert');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (message) {
      expect(errorMessage).to.include(message);
    }
  }
}

describe('Reputation', function () {
  let reputation: Reputation;
  let owner: SignerWithAddress;
  let rewarder: SignerWithAddress;
  let player: SignerWithAddress;
  let other: SignerWithAddress;

  beforeEach(async function () {
    [owner, rewarder, player, other] = await ethers.getSigners();

    const ReputationFactory = new Reputation__factory(owner);
    reputation = await ReputationFactory.deploy();
    await reputation.waitForDeployment();

    const rewardRole = await reputation.REWARD_ROLE();
    await reputation.grantRole(rewardRole, rewarder.address);
  });

  describe('Deployment', function () {
    it('should grant admin role to deployer', async function () {
      const adminRole = await reputation.DEFAULT_ADMIN_ROLE();
      expect(await reputation.hasRole(adminRole, owner.address)).to.equal(true);
    });

    it('should grant reward role to deployer', async function () {
      const rewardRole = await reputation.REWARD_ROLE();
      expect(await reputation.hasRole(rewardRole, owner.address)).to.equal(true);
    });
  });

  describe('Player Initialization', function () {
    it('should initialize player profile', async function () {
      await reputation.initializePlayer(player.address);

      const profile = await reputation.profileFor(player.address);
      expect(profile.level).to.equal(1);
      expect(profile.xp).to.equal(0);
      expect(profile.questCount).to.equal(0);
      expect(profile.streak).to.equal(0);
    });

    it('should emit PlayerInitialized event', async function () {
      await expect(
        reputation.initializePlayer(player.address)
      ).to.emit(reputation, 'PlayerInitialized');
    });

    it('should not reinitialize existing player', async function () {
      await reputation.initializePlayer(player.address);

      // Get initial lastQuestAt
      let profile = await reputation.profileFor(player.address);
      const initialTime = profile.lastQuestAt;

      // Try to reinitialize
      await reputation.initializePlayer(player.address);

      profile = await reputation.profileFor(player.address);
      // lastQuestAt should not change (indicates no reinitialization)
      expect(profile.lastQuestAt).to.equal(initialTime);
    });

    it('should revert with zero address', async function () {
      await expect(
        reputation.initializePlayer(ethers.ZeroAddress)
      ).to.be.revertedWith('Invalid player address');
    });
  });

  describe('XP Rewards', function () {
    beforeEach(async function () {
      await reputation.initializePlayer(player.address);
    });

    it('should reward XP with REWARD_ROLE', async function () {
      await reputation.connect(rewarder).rewardXP(player.address, 500, 1);

      const profile = await reputation.profileFor(player.address);
      expect(profile.xp).to.equal(500);
      expect(profile.questCount).to.equal(1);
      expect(profile.onchainActions).to.equal(1);
    });

    it('should calculate level correctly', async function () {
      // 1500 XP per level
      await reputation.connect(rewarder).rewardXP(player.address, 1500, 1);

      const profile = await reputation.profileFor(player.address);
      expect(profile.level).to.equal(2); // 1 + 1500/1500
    });

    it('should update streak on consecutive quests', async function () {
      await reputation.connect(rewarder).rewardXP(player.address, 100, 1);

      await time.increase(60 * 60);

      await reputation.connect(rewarder).rewardXP(player.address, 100, 1);

      const profile = await reputation.profileFor(player.address);
      expect(profile.streak).to.equal(2);
    });

    it('should reset streak after 1 day gap', async function () {
      await reputation.connect(rewarder).rewardXP(player.address, 100, 1);

      await time.increase(24 * 60 * 60 + 1);

      await reputation.connect(rewarder).rewardXP(player.address, 100, 1);

      const profile = await reputation.profileFor(player.address);
      expect(profile.streak).to.equal(1);
    });

    it('should accumulate multiple XP rewards', async function () {
      await reputation.connect(rewarder).rewardXP(player.address, 300, 1);
      await reputation.connect(rewarder).rewardXP(player.address, 200, 1);
      await reputation.connect(rewarder).rewardXP(player.address, 500, 2);

      const profile = await reputation.profileFor(player.address);
      expect(profile.xp).to.equal(1000);
      expect(profile.questCount).to.equal(3);
      expect(profile.onchainActions).to.equal(4);
    });

    it('should emit ReputationUpdated event', async function () {
      await expect(
        reputation.connect(rewarder).rewardXP(player.address, 500, 1)
      ).to.emit(reputation, 'ReputationUpdated');
    });

    it('should revert without REWARD_ROLE', async function () {
      await expectRevert(reputation.connect(player).rewardXP(player.address, 500, 1), 'AccessControl:');
    });

    it('should revert if player not initialized', async function () {
      await expect(
        reputation.connect(rewarder).rewardXP(other.address, 500, 1)
      ).to.be.revertedWith('Player not initialized');
    });

    it('should revert with zero XP', async function () {
      await expect(
        reputation.connect(rewarder).rewardXP(player.address, 0, 1)
      ).to.be.revertedWith('XP gain must be positive');
    });

    it('should revert with zero address', async function () {
      await expect(
        reputation.connect(rewarder).rewardXP(ethers.ZeroAddress, 500, 1)
      ).to.be.revertedWith('Invalid player address');
    });
  });

  describe('Access Control', function () {
    it('should allow owner to grant REWARD_ROLE', async function () {
      const rewardRole = await reputation.REWARD_ROLE();
      await reputation.grantRewardRole(other.address);

      expect(await reputation.hasRole(rewardRole, other.address)).to.equal(true);
    });

    it('should allow owner to revoke REWARD_ROLE', async function () {
      const rewardRole = await reputation.REWARD_ROLE();
      await reputation.revokeRewardRole(rewarder.address);

      expect(await reputation.hasRole(rewardRole, rewarder.address)).to.equal(false);
    });

    it('should not allow non-owner to grant roles', async function () {
      await expectRevert(
        reputation.connect(player).grantRewardRole(other.address),
        'Ownable: caller is not the owner'
      );
    });

    it('should revert granting role to zero address', async function () {
      await expect(
        reputation.grantRewardRole(ethers.ZeroAddress)
      ).to.be.revertedWith('Invalid account');
    });
  });

  describe('Pause Functionality', function () {
    it('should pause initialization', async function () {
      await reputation.pause();

      await expectRevert(reputation.initializePlayer(player.address), 'Pausable: paused');
    });

    it('should pause XP rewards', async function () {
      await reputation.initializePlayer(player.address);
      await reputation.pause();

      const rewarderWithRole = reputation.connect(rewarder);

      await expectRevert(rewarderWithRole.rewardXP(player.address, 500, 1), 'Pausable: paused');
    });

    it('should allow owner to unpause', async function () {
      await reputation.pause();
      await reputation.unpause();

      // Should work after unpause
      await reputation.initializePlayer(player.address);
      const profile = await reputation.profileFor(player.address);
      expect(profile.level).to.equal(1);
    });

    it('should not allow non-owner to pause', async function () {
      await expectRevert(reputation.connect(player).pause(), 'Ownable: caller is not the owner');
    });
  });

  describe('View Functions', function () {
    it('should return zero profile for uninitialized player', async function () {
      const profile = await reputation.profileFor(other.address);
      expect(profile.level).to.equal(0);
      expect(profile.xp).to.equal(0);
    });

    it('should support interface queries', async function () {
      // AccessControl interface ID
      expect(await reputation.supportsInterface('0x7965db0b')).to.equal(true);
      // ERC165 interface ID
      expect(await reputation.supportsInterface('0x01ffc9a7')).to.equal(true);
    });
  });
});
