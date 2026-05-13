import { expect } from 'chai';
import hre from 'hardhat';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import {
  ForgeQuestManager__factory,
  MockERC20__factory,
  Reputation__factory,
  RewardNFT__factory,
  Treasury__factory,
  type ForgeQuestManager,
  type MockERC20,
  type Reputation,
  type RewardNFT,
  type Treasury,
} from '../typechain-types';

const { ethers } = hre;

describe('Smart Contracts Integration', function () {
  let forgeQuestManager: ForgeQuestManager;
  let rewardNFT: RewardNFT;
  let reputation: Reputation;
  let treasury: Treasury;
  let rewardToken: MockERC20;
  let owner: SignerWithAddress;
  let verifier: SignerWithAddress;
  let player: SignerWithAddress;

  const stake = ethers.parseEther('0.01');
  const reward = ethers.parseEther('0.03');

  beforeEach(async function () {
    [owner, verifier, player] = await ethers.getSigners();

    const MockERC20Factory = new MockERC20__factory(owner);
    rewardToken = await MockERC20Factory.deploy();
    await rewardToken.waitForDeployment();

    const RewardNFTFactory = new RewardNFT__factory(owner);
    rewardNFT = await RewardNFTFactory.deploy(owner.address);
    await rewardNFT.waitForDeployment();

    const TreasuryFactory = new Treasury__factory(owner);
    treasury = await TreasuryFactory.deploy(await rewardToken.getAddress());
    await treasury.waitForDeployment();
    await treasury.fundNativeRewardPool({ value: ethers.parseEther('5') });

    const ReputationFactory = new Reputation__factory(owner);
    reputation = await ReputationFactory.deploy();
    await reputation.waitForDeployment();

    const ForgeQuestManagerFactory = new ForgeQuestManager__factory(owner);
    forgeQuestManager = await ForgeQuestManagerFactory.deploy(
      await rewardNFT.getAddress(),
      await reputation.getAddress(),
      await treasury.getAddress()
    );
    await forgeQuestManager.waitForDeployment();

    const minterRole = await rewardNFT.MINTER_ROLE();
    await rewardNFT.grantRole(minterRole, await forgeQuestManager.getAddress());

    const rewardRole = await reputation.REWARD_ROLE();
    await reputation.grantRole(rewardRole, await forgeQuestManager.getAddress());

    const questManagerRole = await treasury.QUEST_MANAGER_ROLE();
    await treasury.grantRole(questManagerRole, await forgeQuestManager.getAddress());

    await forgeQuestManager.grantVerifier(verifier.address);
  });

  async function createQuest() {
    await forgeQuestManager.connect(player).createQuest(
      'Test Quest',
      'ipfs://metadata',
      stake,
      reward,
      1000,
      86400
    );
  }

  it('creates a quest and reserves the reward in treasury', async function () {
    await createQuest();

    const quest = await forgeQuestManager.quests(1);
    const questFund = await treasury.questFunds(1);

    expect(quest.title).to.equal('Test Quest');
    expect(quest.status).to.equal(0);
    expect(questFund.reservedReward).to.equal(reward);
    expect(questFund.lockedStake).to.equal(0);
    expect(questFund.state).to.equal(1);
  });

  it('starts a quest by locking native stake in treasury instead of holding funds in the manager', async function () {
    await createQuest();

    await forgeQuestManager.connect(player).startQuest(1, { value: stake });

    const quest = await forgeQuestManager.quests(1);
    const questFund = await treasury.questFunds(1);

    expect(quest.player).to.equal(player.address);
    expect(quest.status).to.equal(1);
    expect(questFund.player).to.equal(player.address);
    expect(questFund.lockedStake).to.equal(stake);
    expect(questFund.state).to.equal(2);
    expect(await ethers.provider.getBalance(await forgeQuestManager.getAddress())).to.equal(0);
  });

  it('settles a verified completion entirely through treasury payout flow', async function () {
    await createQuest();
    await forgeQuestManager.connect(player).startQuest(1, { value: stake });

    const proofUri = '0x3333333333333333333333333333333333333333333333333333333333333333';
    await forgeQuestManager.connect(player).submitQuest(1, proofUri);
    const questBeforeVerification = await forgeQuestManager.quests(1);
    const playerBalanceBefore = await ethers.provider.getBalance(player.address);
    const treasuryBalanceBefore = await ethers.provider.getBalance(await treasury.getAddress());

    await expect(forgeQuestManager.connect(verifier).verifyQuest(1, true, questBeforeVerification.proofVerificationHash))
      .to.emit(treasury, 'RewardPaid')
      .withArgs(1, player.address, reward, stake, reward + stake);

    const playerBalanceAfter = await ethers.provider.getBalance(player.address);
    const treasuryBalanceAfter = await ethers.provider.getBalance(await treasury.getAddress());
    const verifiedQuest = await forgeQuestManager.quests(1);
    const questFund = await treasury.questFunds(1);
    const profile = await reputation.profileFor(player.address);

    expect(playerBalanceAfter - playerBalanceBefore).to.equal(reward + stake);
    expect(treasuryBalanceBefore - treasuryBalanceAfter).to.equal(reward + stake);
    expect(verifiedQuest.status).to.equal(3);
    expect(questFund.state).to.equal(3);
    expect(await rewardNFT.balanceOf(player.address)).to.equal(1);
    expect(await rewardNFT.tokenURI(1)).to.equal(proofUri);
    expect(profile.xp).to.equal(1000);
    expect(profile.questCount).to.equal(1);
    expect(await ethers.provider.getBalance(await forgeQuestManager.getAddress())).to.equal(0);
  });

  it('refunds the player stake and releases the reward reservation on failed verification', async function () {
    await createQuest();
    await forgeQuestManager.connect(player).startQuest(1, { value: stake });

    const proofUri = '0x4444444444444444444444444444444444444444444444444444444444444444';
    await forgeQuestManager.connect(player).submitQuest(1, proofUri);

    const quest = await forgeQuestManager.quests(1);
    const playerBalanceBefore = await ethers.provider.getBalance(player.address);

    await expect(forgeQuestManager.connect(verifier).verifyQuest(1, false, quest.proofVerificationHash))
      .to.emit(treasury, 'RewardRefunded')
      .withArgs(
        1,
        player.address,
        reward,
        stake,
        ethers.keccak256(ethers.toUtf8Bytes('QUEST_FAILED'))
      );

    const playerBalanceAfter = await ethers.provider.getBalance(player.address);
    const failedQuest = await forgeQuestManager.quests(1);
    const questFund = await treasury.questFunds(1);

    expect(playerBalanceAfter - playerBalanceBefore).to.equal(stake);
    expect(failedQuest.status).to.equal(5);
    expect(questFund.state).to.equal(4);
  });

  it('cancels an active quest by refunding locked stake from treasury', async function () {
    await createQuest();
    await forgeQuestManager.connect(player).startQuest(1, { value: stake });

    const treasuryBalanceBefore = await ethers.provider.getBalance(await treasury.getAddress());
    await forgeQuestManager.connect(player).cancelQuest(1);
    const treasuryBalanceAfter = await ethers.provider.getBalance(await treasury.getAddress());

    const cancelledQuest = await forgeQuestManager.quests(1);
    const questFund = await treasury.questFunds(1);

    expect(treasuryBalanceBefore - treasuryBalanceAfter).to.equal(stake);
    expect(cancelledQuest.status).to.equal(4);
    expect(questFund.state).to.equal(4);
  });

  it('rejects invalid quest creation when the treasury reward pool is underfunded', async function () {
    await treasury.pause();
    await treasury.emergencyWithdrawNative(owner.address, ethers.parseEther('4.98'));
    await treasury.unpause();

    await expect(createQuest()).to.be.revertedWith('Insufficient treasury liquidity');
  });
});
