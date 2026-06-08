import { expect } from 'chai';
import hre from 'hardhat';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { RewardNFT__factory, type RewardNFT } from '../typechain-types';

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

describe('RewardNFT', function () {
  let rewardNFT: RewardNFT;
  let owner: SignerWithAddress;
  let minter: SignerWithAddress;
  let player: SignerWithAddress;
  let other: SignerWithAddress;

  beforeEach(async function () {
    [owner, minter, player, other] = await ethers.getSigners();

    const RewardNFTFactory = new RewardNFT__factory(owner);
    rewardNFT = await RewardNFTFactory.deploy(owner.address);
    await rewardNFT.waitForDeployment();

    const minterRole = await rewardNFT.MINTER_ROLE();
    await rewardNFT.grantRole(minterRole, minter.address);
  });

  describe('Deployment', function () {
    it('should have correct name and symbol', async function () {
      expect(await rewardNFT.name()).to.equal('ForgeQuest Reward');
      expect(await rewardNFT.symbol()).to.equal('QFR');
    });

    it('should grant admin role to deployer', async function () {
      const adminRole = await rewardNFT.DEFAULT_ADMIN_ROLE();
      expect(await rewardNFT.hasRole(adminRole, owner.address)).to.equal(true);
    });

    it('should grant minter role to deployer', async function () {
      const minterRole = await rewardNFT.MINTER_ROLE();
      expect(await rewardNFT.hasRole(minterRole, owner.address)).to.equal(true);
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
      await expectRevert(
        rewardNFT.connect(player).mintQuestReward(player.address, 1, 'ipfs://metadata/1'),
        'AccessControl:'
      );
    });
  });

  describe('Access Control', function () {
    it('should allow admin to grant MINTER_ROLE', async function () {
      const minterRole = await rewardNFT.MINTER_ROLE();
      await rewardNFT.grantRole(minterRole, other.address);

      expect(await rewardNFT.hasRole(minterRole, other.address)).to.equal(true);
    });

    it('should allow admin to revoke MINTER_ROLE', async function () {
      const minterRole = await rewardNFT.MINTER_ROLE();
      await rewardNFT.revokeRole(minterRole, minter.address);

      expect(await rewardNFT.hasRole(minterRole, minter.address)).to.equal(false);
    });

    it('should support interface queries', async function () {
      // ERC721 interface ID
      expect(await rewardNFT.supportsInterface('0x80ac58cd')).to.equal(true);
      // ERC165 interface ID
      expect(await rewardNFT.supportsInterface('0x01ffc9a7')).to.equal(true);
      // AccessControl interface ID
      expect(await rewardNFT.supportsInterface('0x7965db0b')).to.equal(true);
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
