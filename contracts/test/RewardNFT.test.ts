import { expect } from 'chai';
import hre from 'hardhat';
import type { Contract } from 'ethers';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

const { ethers } = hre;

describe('RewardNFT', function () {
  let rewardNFT: Contract;
  let owner: SignerWithAddress;
  let minter: SignerWithAddress;
  let player: SignerWithAddress;
  let other: SignerWithAddress;

  beforeEach(async function () {
    [owner, minter, player, other] = await ethers.getSigners();

    const RewardNFTFactory = await ethers.getContractFactory('RewardNFT', owner);
    rewardNFT = await RewardNFTFactory.deploy(owner.address);
    await rewardNFT.waitForDeployment();

    const minterRole = await rewardNFT.MINTER_ROLE();
    await rewardNFT.grantRole(minterRole, minter.address);
  });

  describe('Deployment', function () {
    it('should have correct name and symbol', async function () {
      expect(await rewardNFT.name()).to.equal('QuestForge Reward');
      expect(await rewardNFT.symbol()).to.equal('QFR');
    });

    it('should grant admin role to deployer', async function () {
      const adminRole = await rewardNFT.DEFAULT_ADMIN_ROLE();
      expect(await rewardNFT.hasRole(adminRole, owner.address)).to.be.true;
    });

    it('should grant minter role to deployer', async function () {
      const minterRole = await rewardNFT.MINTER_ROLE();
      expect(await rewardNFT.hasRole(minterRole, owner.address)).to.be.true;
    });
  });

  describe('NFT Minting', function () {
    it('should mint reward NFT with MINTER_ROLE', async function () {
      const tx = await rewardNFT.connect(minter).mintQuestReward(
        player.address,
        1, // questId
        'ipfs://metadata/1'
      );
      await tx.wait();

      expect(await rewardNFT.balanceOf(player.address)).to.equal(1);
    });

    it('should store quest history', async function () {
      await rewardNFT.connect(minter).mintQuestReward(
        player.address,
        42, // questId
        'ipfs://metadata/1'
      );

      const questId = await rewardNFT.questHistory(1);
      expect(questId).to.equal(42);
    });

    it('should set token URI', async function () {
      await rewardNFT.connect(minter).mintQuestReward(
        player.address,
        1,
        'ipfs://metadata/1'
      );

      const uri = await rewardNFT.tokenURI(1);
      expect(uri).to.equal('ipfs://metadata/1');
    });

    it('should increment token IDs', async function () {
      await rewardNFT.connect(minter).mintQuestReward(
        player.address,
        1,
        'ipfs://metadata/1'
      );
      await rewardNFT.connect(minter).mintQuestReward(
        other.address,
        2,
        'ipfs://metadata/2'
      );

      expect(await rewardNFT.balanceOf(player.address)).to.equal(1);
      expect(await rewardNFT.balanceOf(other.address)).to.equal(1);
    });

    it('should emit RewardMinted event', async function () {
      await expect(
        rewardNFT.connect(minter).mintQuestReward(
          player.address,
          1,
          'ipfs://metadata/1'
        )
      ).to.emit(rewardNFT, 'RewardMinted');
    });

    it('should revert without MINTER_ROLE', async function () {
      await expect(
        rewardNFT.connect(player).mintQuestReward(
          player.address,
          1,
          'ipfs://metadata/1'
        )
      ).to.be.reverted;
    });
  });

  describe('Access Control', function () {
    it('should allow admin to grant MINTER_ROLE', async function () {
      const minterRole = await rewardNFT.MINTER_ROLE();
      await rewardNFT.grantRole(minterRole, other.address);

      expect(await rewardNFT.hasRole(minterRole, other.address)).to.be.true;
    });

    it('should allow admin to revoke MINTER_ROLE', async function () {
      const minterRole = await rewardNFT.MINTER_ROLE();
      await rewardNFT.revokeRole(minterRole, minter.address);

      expect(await rewardNFT.hasRole(minterRole, minter.address)).to.be.false;
    });

    it('should support interface queries', async function () {
      // ERC721 interface ID
      expect(await rewardNFT.supportsInterface('0x80ac58cd')).to.be.true;
      // ERC165 interface ID
      expect(await rewardNFT.supportsInterface('0x01ffc9a7')).to.be.true;
      // AccessControl interface ID
      expect(await rewardNFT.supportsInterface('0x7965db0b')).to.be.true;
    });
  });

  describe('ERC721 Compliance', function () {
    beforeEach(async function () {
      await rewardNFT.connect(minter).mintQuestReward(
        player.address,
        1,
        'ipfs://metadata/1'
      );
    });

    it('should allow token owner to transfer', async function () {
      await rewardNFT.connect(player).transferFrom(player.address, other.address, 1);

      expect(await rewardNFT.balanceOf(player.address)).to.equal(0);
      expect(await rewardNFT.balanceOf(other.address)).to.equal(1);
    });

    it('should track token ownership', async function () {
      expect(await rewardNFT.ownerOf(1)).to.equal(player.address);
    });
  });
});
