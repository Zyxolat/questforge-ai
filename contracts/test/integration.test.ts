import { expect } from 'chai';
import hre from 'hardhat';
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

const { ethers } = hre;

describe('Smart Contracts Integration', function () {
  let forgeQuestManager: ForgeQuestManager;
  let rewardNFT: RewardNFT;
  let reputation: Reputation;
  let treasury: Treasury;
  let owner: SignerWithAddress;
  let verifier: SignerWithAddress;
  let player: SignerWithAddress;

  const reward = ethers.parseEther('0.03');

  beforeEach(async function () {
    [owner, verifier, player] = await ethers.getSigners();

    const RewardNFTFactory = new RewardNFT__factory(owner);
    rewardNFT = await RewardNFTFactory.deploy(owner.address);
    await rewardNFT.waitForDeployment();

    const TreasuryFactory = new Treasury__factory(owner);
    treasury = await TreasuryFactory.deploy();
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
      reward,
      1000,
      86400,
      {
        value: ethers.parseEther('0.001')
      }
    );
  }

  it('creates a quest and reserves the reward in treasury', async function () {
    await createQuest();

    const quest = await forgeQuestManager.quests(1);
    const questFund = await treasury.questFunds(1);

    expect(quest.title).to.equal('Test Quest');
    expect(quest.status).to.equal(1);
    expect(quest.player).to.equal(player.address);
    expect(questFund.reservedReward).to.equal(reward);
    expect(questFund.player).to.equal(player.address);
    expect(questFund.state).to.equal(1);
  });

  it('activates a quest immediately on creation and reserves the reward in treasury', async function () {
    await createQuest();

    const quest = await forgeQuestManager.quests(1);
    const questFund = await treasury.questFunds(1);

    expect(quest.player).to.equal(player.address);
    expect(quest.status).to.equal(1);
    expect(questFund.player).to.equal(player.address);
    expect(questFund.reservedReward).to.equal(reward);
    expect(questFund.state).to.equal(1);
    expect(await ethers.provider.getBalance(await forgeQuestManager.getAddress())).to.equal(0);
  });

  it('settles a verified completion entirely through treasury payout flow', async function () {
    await createQuest();

    const proofUri = '0x3333333333333333333333333333333333333333333333333333333333333333';
    await forgeQuestManager.connect(player).submitQuest(1, proofUri);
    const questBeforeVerification = await forgeQuestManager.quests(1);
    const playerBalanceBefore = await ethers.provider.getBalance(player.address);
    const treasuryBalanceBefore = await ethers.provider.getBalance(await treasury.getAddress());

    await forgeQuestManager.connect(verifier).verifyQuest(1, true, questBeforeVerification.proofVerificationHash);

    const claimTx = await forgeQuestManager.connect(player).claimReward(1);
    const receipt = await claimTx.wait();

    await expect(claimTx)
      .to.emit(treasury, 'RewardPaid')
      .withArgs(1, player.address, reward, reward);

    const gasPrice = receipt?.gasPrice ?? 0n;
    const gasCost = receipt ? BigInt(receipt.gasUsed ?? 0n) * BigInt(gasPrice) : 0n;
    const playerBalanceAfter = await ethers.provider.getBalance(player.address);
    const treasuryBalanceAfter = await ethers.provider.getBalance(await treasury.getAddress());
    const verifiedQuest = await forgeQuestManager.quests(1);
    const questFund = await treasury.questFunds(1);
    const profile = await reputation.profileFor(player.address);

    expect((playerBalanceAfter - playerBalanceBefore) + gasCost).to.equal(reward);
    expect(treasuryBalanceBefore - treasuryBalanceAfter).to.equal(reward);
    expect(verifiedQuest.status).to.equal(4);
    expect(questFund.state).to.equal(2);
    expect(await rewardNFT.balanceOf(player.address)).to.equal(1);
    // proofUri is a hash, not a valid http/https URI, so it falls back to metadataUri
    expect(await rewardNFT.tokenURI(1)).to.equal('ipfs://metadata');
    expect(profile.xp).to.equal(1000);
    expect(profile.questCount).to.equal(1);
    expect(await ethers.provider.getBalance(await forgeQuestManager.getAddress())).to.equal(0);
  });

  it('releases the reserved reward on failed verification without stake', async function () {
    await createQuest();

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
        ethers.keccak256(ethers.toUtf8Bytes('VERIFICATION_FAILED'))
      );

    const playerBalanceAfter = await ethers.provider.getBalance(player.address);
    const failedQuest = await forgeQuestManager.quests(1);
    const questFund = await treasury.questFunds(1);

    expect(playerBalanceAfter - playerBalanceBefore).to.equal(0);
    expect(failedQuest.status).to.equal(1);
    expect(questFund.state).to.equal(3);
  });

  it('cancels an active quest by releasing the reserved reward when no stake is locked', async function () {
    await createQuest();

    const treasuryBalanceBefore = await ethers.provider.getBalance(await treasury.getAddress());
    await forgeQuestManager.connect(player).cancelQuest(1);
    const treasuryBalanceAfter = await ethers.provider.getBalance(await treasury.getAddress());

    const cancelledQuest = await forgeQuestManager.quests(1);
    const questFund = await treasury.questFunds(1);

    expect(treasuryBalanceBefore - treasuryBalanceAfter).to.equal(0);
    expect(cancelledQuest.status).to.equal(5);
    expect(questFund.state).to.equal(3);
  });

  it('rejects invalid quest creation when the treasury reward pool is underfunded', async function () {
    await treasury.pause();
    await treasury.emergencyWithdrawNative(owner.address, ethers.parseEther('4.98'));
    await treasury.unpause();

    await expect(createQuest()).to.be.revertedWith('Insufficient treasury liquidity');
  });
});
