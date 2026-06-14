import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import {
  ForgeQuestManager__factory,
  Reputation__factory,
  RewardNFT__factory,
  Treasury__factory,
  type ForgeQuestManager,
  type Reputation,
  type RewardNFT,
  type Treasury,
} from '../typechain-types';

describe('ForgeQuestManager Security', () => {
  let questManager: ForgeQuestManager;
  let rewardNFT: RewardNFT;
  let reputation: Reputation;
  let treasury: Treasury;
  let owner: SignerWithAddress;
  let player1: SignerWithAddress;
  let player2: SignerWithAddress;
  let verifier: SignerWithAddress;
  let guardian: SignerWithAddress;

  const reward = ethers.parseEther('0.03');

  beforeEach(async () => {
    [owner, player1, player2, verifier, guardian] = await ethers.getSigners();

    const RewardNFTFactory = new RewardNFT__factory(owner);
    rewardNFT = await RewardNFTFactory.deploy(owner.address);
    await rewardNFT.waitForDeployment();

    const ReputationFactory = new Reputation__factory(owner);
    reputation = await ReputationFactory.deploy();
    await reputation.waitForDeployment();

    const TreasuryFactory = new Treasury__factory(owner);
    treasury = await TreasuryFactory.deploy();
    await treasury.waitForDeployment();
    await treasury.fundNativeRewardPool({ value: ethers.parseEther('1') });

    const QuestManagerFactory = new ForgeQuestManager__factory(owner);
    questManager = await QuestManagerFactory.deploy(
      await rewardNFT.getAddress(),
      await reputation.getAddress(),
      await treasury.getAddress()
    );
    await questManager.waitForDeployment();

    const minterRole = await rewardNFT.MINTER_ROLE();
    await rewardNFT.grantRole(minterRole, await questManager.getAddress());

    const rewardRole = await reputation.REWARD_ROLE();
    await reputation.grantRole(rewardRole, await questManager.getAddress());

    const questManagerRole = await treasury.QUEST_MANAGER_ROLE();
    const guardianRole = await treasury.GUARDIAN_ROLE();
    await treasury.grantRole(questManagerRole, await questManager.getAddress());
    await treasury.grantRole(guardianRole, guardian.address);

    await questManager.grantVerifier(verifier.address);
  });

  async function createQuest(title: string) {
    await questManager.connect(player1).createAndAcceptQuest(title, 'ipfs://metadata', reward, 150, 3600, {
      value: ethers.parseEther('0.001')
    });
  }

  describe('Replay Attack Prevention', () => {
    it('prevents submitting the same proof for different quests', async () => {
      await createQuest('Quest 1');
      await createQuest('Quest 2');

      await questManager.connect(player1).submitQuest(1, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      await expect(
        questManager.connect(player1).submitQuest(2, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      ).to.be.revertedWith('Proof already submitted for different quest');
    });

    it('tracks player nonces correctly through immediate quest activation', async () => {
      await createQuest('Quest 1');
      await createQuest('Quest 2');

      expect(await questManager.playerNonces(player1.address)).to.equal(2n);
    });
  });

  describe('Reward Bounds Enforcement', () => {
    it('creates active quests with zero stake', async () => {
      await questManager.connect(player1).createAndAcceptQuest('Quest', 'uri', reward, 150, 3600, {
        value: ethers.parseEther('0.001')
      });
      const quest = await questManager.quests(1);
      expect(quest.stakeAmount).to.equal(0);
      expect(quest.status).to.equal(1);
    });

    it('rejects reward above maximum', async () => {
      await expect(
        questManager.connect(player1).createAndAcceptQuest('Quest', 'uri', ethers.parseEther('1'), 150, 3600, {
          value: ethers.parseEther('0.001')
        })
      ).to.be.revertedWith('Reward exceeds maximum');
    });
  });

  describe('Treasury Solvency And Double-Payout Protection', () => {
    it('rejects new quests when treasury cannot reserve the reward', async () => {
      await treasury.pause();
      await treasury.emergencyWithdrawNative(owner.address, ethers.parseEther('0.98'));
      await treasury.unpause();

      await expect(
        questManager.createAndAcceptQuest('Quest', 'uri', reward, 150, 3600, {
          value: ethers.parseEther('0.001')
        })
      ).to.be.revertedWith('Insufficient treasury liquidity');
    });

    it('prevents a second payout after a successful verification', async () => {
      await createQuest('Quest');

      const proofUri = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      await questManager.connect(player1).submitQuest(1, proofUri);
      const quest = await questManager.quests(1);

      await questManager.connect(verifier).verifyQuest(1, true, quest.proofVerificationHash);
      await questManager.connect(player1).claimReward(1);

      await expect(
        questManager.connect(player1).claimReward(1)
      ).to.be.revertedWith('Reward not claimable');
    });
  });

  describe('Deterministic Verification', () => {
    it('requires the correct verification hash', async () => {
      await createQuest('Quest');

      const proofUri = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
      await questManager.connect(player1).submitQuest(1, proofUri);

      await expect(
        questManager.connect(verifier).verifyQuest(1, true, ethers.id('wrong'))
      ).to.be.revertedWith('Verification hash mismatch');
    });
  });

  describe('Emergency Pause And Circuit Breaker', () => {
    it('blocks treasury-backed quest creation while the treasury is paused', async () => {
      await treasury.connect(guardian).tripCircuitBreaker('suspected drain');

      await expect(
        questManager.createQuest('Quest', 'uri', reward, 150, 3600, {
          value: ethers.parseEther('0.001')
        })
      ).to.be.revertedWith('Pausable: paused');
    });

    it('blocks settlement while treasury is paused', async () => {
      await createQuest('Quest');

      const proofUri = '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
      await questManager.connect(player1).submitQuest(1, proofUri);
      const quest = await questManager.quests(1);

      await questManager.connect(verifier).verifyQuest(1, true, quest.proofVerificationHash);
      await treasury.connect(guardian).pause();

      await expect(
        questManager.connect(player1).claimReward(1)
      ).to.be.revertedWith('Pausable: paused');
    });

    it('allows owner recovery after a manager-level reward pause', async () => {
      await questManager.pauseRewardSystem();
      expect(await questManager.rewardSystemHealthy()).to.equal(false);

      await questManager.unpauseRewardSystem();
      expect(await questManager.rewardSystemHealthy()).to.equal(true);
    });
  });

  describe('Authorization Checks', () => {
    it('only allows the quest player to submit proof', async () => {
      await createQuest('Quest');

      await expect(
        questManager.connect(player2).submitQuest(1, '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
      ).to.be.revertedWith('Not quest player');
    });

    it('does not allow a player to self-verify success', async () => {
      await createQuest('Quest');

      const proofUri = '0x1111111111111111111111111111111111111111111111111111111111111111';
      await questManager.connect(player1).submitQuest(1, proofUri);
      const quest = await questManager.quests(1);

      await expect(
        questManager.connect(player1).verifyQuest(1, true, quest.proofVerificationHash)
      ).to.be.revertedWith('Verifier role required');
    });

    it('only allows treasury-authorized payout orchestration from the quest manager', async () => {
      await expect(
        treasury.connect(player2).reserveReward(1, owner.address, reward)
      ).to.be.reverted;
    });
  });
});
