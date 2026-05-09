import { expect } from 'chai';
import { ethers } from 'hardhat';
import { ForgeQuestManager, RewardNFT, Reputation, Treasury, MockERC20 } from '../typechain-types';

describe('ForgeQuestManager Security', () => {
  let questManager: ForgeQuestManager;
  let rewardNFT: RewardNFT;
  let reputation: Reputation;
  let treasury: Treasury;
  let rewardToken: MockERC20;
  let owner: any;
  let player1: any;
  let player2: any;
  let verifier: any;

  const stake = ethers.parseEther('0.01');
  const reward = ethers.parseEther('0.03');

  beforeEach(async () => {
    [owner, player1, player2, verifier] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory('MockERC20');
    rewardToken = await MockERC20Factory.deploy();
    await rewardToken.waitForDeployment();

    const RewardNFTFactory = await ethers.getContractFactory('RewardNFT');
    rewardNFT = await RewardNFTFactory.deploy(owner.address);
    await rewardNFT.waitForDeployment();

    const ReputationFactory = await ethers.getContractFactory('Reputation');
    reputation = await ReputationFactory.deploy();
    await reputation.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory('Treasury');
    treasury = await TreasuryFactory.deploy(await rewardToken.getAddress());
    await treasury.waitForDeployment();

    const QuestManagerFactory = await ethers.getContractFactory('ForgeQuestManager');
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

    await questManager.grantVerifier(verifier.address);

    await owner.sendTransaction({
      to: await questManager.getAddress(),
      value: ethers.parseEther('5')
    });
  });

  async function createQuest(title: string) {
    await questManager.createQuest(title, 'ipfs://metadata', stake, reward, 150, 3600);
  }

  describe('Replay Attack Prevention', () => {
    it('prevents submitting the same proof for different quests', async () => {
      await createQuest('Quest 1');
      await createQuest('Quest 2');

      await questManager.connect(player1).startQuest(1, { value: stake });
      await questManager.connect(player1).submitQuest(1, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

      await questManager.connect(player1).startQuest(2, { value: stake });
      await expect(
        questManager.connect(player1).submitQuest(2, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      ).to.be.revertedWith('Proof already submitted for different quest');
    });

    it('tracks player nonces correctly', async () => {
      await createQuest('Quest 1');
      await createQuest('Quest 2');

      expect(await questManager.playerNonces(player1.address)).to.equal(0n);
      await questManager.connect(player1).startQuest(1, { value: stake });
      expect(await questManager.playerNonces(player1.address)).to.equal(1n);

      await questManager.connect(player1).startQuest(2, { value: stake });
      expect(await questManager.playerNonces(player1.address)).to.equal(2n);
    });
  });

  describe('Reward Bounds Enforcement', () => {
    it('rejects stake below minimum', async () => {
      await expect(
        questManager.createQuest('Quest', 'uri', ethers.parseEther('0.0001'), reward, 150, 3600)
      ).to.be.revertedWith('Stake too small');
    });

    it('rejects stake above maximum', async () => {
      await expect(
        questManager.createQuest('Quest', 'uri', ethers.parseEther('20'), reward, 150, 3600)
      ).to.be.revertedWith('Stake exceeds maximum');
    });

    it('rejects reward above maximum', async () => {
      await expect(
        questManager.createQuest('Quest', 'uri', stake, ethers.parseEther('1'), 150, 3600)
      ).to.be.revertedWith('Reward exceeds maximum');
    });
  });

  describe('Circuit Breaker Protection', () => {
    it('triggers the circuit breaker when the pool would be exceeded', async () => {
      await questManager.setMaxRewardPoolSize(ethers.parseEther('0.02'));

      await expect(
        questManager.createQuest('Quest', 'uri', stake, reward, 150, 3600)
      ).to.be.revertedWith('Reward system paused');

      expect(await questManager.rewardSystemHealthy()).to.equal(true);
    });

    it('allows owner recovery after a circuit breaker pause', async () => {
      await questManager.pauseRewardSystem();
      expect(await questManager.rewardSystemHealthy()).to.equal(false);

      await questManager.unpauseRewardSystem();
      expect(await questManager.rewardSystemHealthy()).to.equal(true);
    });
  });

  describe('Deterministic Verification', () => {
    it('requires the correct verification hash', async () => {
      await createQuest('Quest');
      await questManager.connect(player1).startQuest(1, { value: stake });

      const proofUri = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      await questManager.connect(player1).submitQuest(1, proofUri);

      await expect(
        questManager.connect(verifier).verifyQuest(1, true, ethers.id('wrong'))
      ).to.be.revertedWith('Verification hash mismatch');
    });

    it('allows the verifier to complete a quest with the stored hash', async () => {
      await createQuest('Quest');
      await questManager.connect(player1).startQuest(1, { value: stake });

      const proofUri = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
      await questManager.connect(player1).submitQuest(1, proofUri);
      const quest = await questManager.quests(1);

      await expect(
        questManager.connect(verifier).verifyQuest(1, true, quest.proofVerificationHash)
      ).to.not.be.reverted;
    });
  });

  describe('Quest State Machine', () => {
    it('enforces the state transitions', async () => {
      await createQuest('Quest');

      await expect(
        questManager.connect(player1).submitQuest(1, '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')
      ).to.be.revertedWith('Not quest player');

      await questManager.connect(player1).startQuest(1, { value: stake });

      await expect(
        questManager.connect(verifier).verifyQuest(1, true, ethers.id('proof'))
      ).to.be.revertedWith('Not submitted');
    });

    it('prevents operations on expired quests', async () => {
      await questManager.createQuest('Quest', 'uri', stake, reward, 150, 1);
      await questManager.connect(player1).startQuest(1, { value: stake });

      await ethers.provider.send('evm_increaseTime', [2]);
      await ethers.provider.send('evm_mine', []);

      await expect(
        questManager.connect(player1).submitQuest(1, '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
      ).to.be.revertedWith('Quest expired');
    });
  });

  describe('Authorization Checks', () => {
    it('only allows the quest player to submit proof', async () => {
      await createQuest('Quest');
      await questManager.connect(player1).startQuest(1, { value: stake });

      await expect(
        questManager.connect(player2).submitQuest(1, '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
      ).to.be.revertedWith('Not quest player');
    });

    it('does not allow a player to self-verify success', async () => {
      await createQuest('Quest');
      await questManager.connect(player1).startQuest(1, { value: stake });

      const proofUri = '0x1111111111111111111111111111111111111111111111111111111111111111';
      await questManager.connect(player1).submitQuest(1, proofUri);
      const quest = await questManager.quests(1);

      await expect(
        questManager.connect(player1).verifyQuest(1, true, quest.proofVerificationHash)
      ).to.be.revertedWith('Verifier role required');
    });

    it('only allows the verifier to mark a quest as failed', async () => {
      await createQuest('Quest');
      await questManager.connect(player1).startQuest(1, { value: stake });

      const proofUri = '0x2222222222222222222222222222222222222222222222222222222222222222';
      await questManager.connect(player1).submitQuest(1, proofUri);
      const quest = await questManager.quests(1);

      await expect(
        questManager.connect(player1).verifyQuest(1, false, quest.proofVerificationHash)
      ).to.be.revertedWith('Verifier role required');
    });
  });
});
