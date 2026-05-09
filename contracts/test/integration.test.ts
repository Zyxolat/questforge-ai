import { expect } from 'chai';
import hre from 'hardhat';
import type { Contract } from 'ethers';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

const { ethers } = hre;

describe('Smart Contracts Integration', function () {
  let forgeQuestManager: Contract;
  let rewardNFT: Contract;
  let reputation: Contract;
  let treasury: Contract;
  let rewardToken: Contract;
  let owner: SignerWithAddress;
  let verifier: SignerWithAddress;
  let player: SignerWithAddress;

  const stake = ethers.parseEther('0.01');
  const reward = ethers.parseEther('0.03');

  beforeEach(async function () {
    [owner, verifier, player] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory('MockERC20', owner);
    rewardToken = await MockERC20Factory.deploy();
    await rewardToken.waitForDeployment();

    const RewardNFTFactory = await ethers.getContractFactory('RewardNFT', owner);
    rewardNFT = await RewardNFTFactory.deploy(owner.address);
    await rewardNFT.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory('Treasury', owner);
    treasury = await TreasuryFactory.deploy(await rewardToken.getAddress());
    await treasury.waitForDeployment();

    const ReputationFactory = await ethers.getContractFactory('Reputation', owner);
    reputation = await ReputationFactory.deploy();
    await reputation.waitForDeployment();

    const ForgeQuestManagerFactory = await ethers.getContractFactory('ForgeQuestManager', owner);
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

    await forgeQuestManager.grantVerifier(verifier.address);

    await owner.sendTransaction({
      to: await forgeQuestManager.getAddress(),
      value: ethers.parseEther('10')
    });
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

  it('deploys all contracts', async function () {
    expect(await rewardNFT.getAddress()).to.be.properAddress;
    expect(await treasury.getAddress()).to.be.properAddress;
    expect(await reputation.getAddress()).to.be.properAddress;
    expect(await forgeQuestManager.getAddress()).to.be.properAddress;
  });

  it('creates a quest', async function () {
    await createQuest();
    const quest = await forgeQuestManager.quests(1);

    expect(quest.title).to.equal('Test Quest');
    expect(quest.xpReward).to.equal(1000);
    expect(quest.status).to.equal(0);
  });

  it('starts a quest and initializes the player', async function () {
    await createQuest();
    await forgeQuestManager.connect(player).startQuest(1, { value: stake });

    const quest = await forgeQuestManager.quests(1);
    expect(quest.player).to.equal(player.address);
    expect(quest.status).to.equal(1);

    const profile = await reputation.profileFor(player.address);
    expect(profile.level).to.equal(1);
  });

  it('submits proof and verifies the quest through the verifier role', async function () {
    await createQuest();
    await forgeQuestManager.connect(player).startQuest(1, { value: stake });

    const proofUri = '0x3333333333333333333333333333333333333333333333333333333333333333';
    await forgeQuestManager.connect(player).submitQuest(1, proofUri);
    const quest = await forgeQuestManager.quests(1);

    await expect(forgeQuestManager.connect(verifier).verifyQuest(1, true, quest.proofVerificationHash))
      .to.emit(forgeQuestManager, 'QuestVerified')
      .withArgs(1, player.address, true, reward, 1000, ethers.keccak256(ethers.toUtf8Bytes(proofUri)));

    expect(await rewardNFT.balanceOf(player.address)).to.equal(1);
    expect(await rewardNFT.tokenURI(1)).to.equal(proofUri);

    const profile = await reputation.profileFor(player.address);
    expect(profile.xp).to.equal(1000);
    expect(profile.questCount).to.equal(1);
  });

  it('handles failed verification by sending the stake to treasury', async function () {
    await createQuest();
    await forgeQuestManager.connect(player).startQuest(1, { value: stake });

    const proofUri = '0x4444444444444444444444444444444444444444444444444444444444444444';
    await forgeQuestManager.connect(player).submitQuest(1, proofUri);

    const quest = await forgeQuestManager.quests(1);
    const treasuryBalanceBefore = await ethers.provider.getBalance(await treasury.getAddress());

    await forgeQuestManager.connect(verifier).verifyQuest(1, false, quest.proofVerificationHash);

    const treasuryBalanceAfter = await ethers.provider.getBalance(await treasury.getAddress());
    const failedQuest = await forgeQuestManager.quests(1);

    expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(stake);
    expect(failedQuest.status).to.equal(5);
  });

  it('rejects invalid quest creation values', async function () {
    await expect(
      forgeQuestManager.connect(player).createQuest(
        'Test Quest',
        'ipfs://metadata',
        0,
        reward,
        1000,
        86400
      )
    ).to.be.revertedWith('Stake too small');
  });

  it('prevents non-verifiers from completing quests', async function () {
    const [, , , other] = await ethers.getSigners();

    await createQuest();
    await forgeQuestManager.connect(player).startQuest(1, { value: stake });

    const proofUri = '0x5555555555555555555555555555555555555555555555555555555555555555';
    await forgeQuestManager.connect(player).submitQuest(1, proofUri);
    const quest = await forgeQuestManager.quests(1);

    await expect(
      forgeQuestManager.connect(other).verifyQuest(1, true, quest.proofVerificationHash)
    ).to.be.revertedWith('Verifier role required');
  });

  it('manages verifier roles', async function () {
    const [, , , other] = await ethers.getSigners();
    const verifierRole = await forgeQuestManager.VERIFIER_ROLE();

    await forgeQuestManager.grantVerifier(other.address);
    expect(await forgeQuestManager.hasRole(verifierRole, other.address)).to.equal(true);

    await forgeQuestManager.revokeVerifier(other.address);
    expect(await forgeQuestManager.hasRole(verifierRole, other.address)).to.equal(false);
  });
});
