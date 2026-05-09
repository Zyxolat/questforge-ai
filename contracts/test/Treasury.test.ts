import { expect } from 'chai';
import hre from 'hardhat';
import type { Contract } from 'ethers';
import type { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

const { ethers } = hre;

describe('Treasury', function () {
  let treasury: Contract;
  let rewardToken: Contract;
  let owner: SignerWithAddress;
  let player: SignerWithAddress;
  let other: SignerWithAddress;

  beforeEach(async function () {
    [owner, player, other] = await ethers.getSigners();

    const MockERC20Factory = await ethers.getContractFactory('MockERC20', owner);
    rewardToken = await MockERC20Factory.deploy();
    await rewardToken.waitForDeployment();
    await rewardToken.mint(owner.address, ethers.parseEther('1000'));

    const TreasuryFactory = await ethers.getContractFactory('Treasury', owner);
    treasury = await TreasuryFactory.deploy(await rewardToken.getAddress());
    await treasury.waitForDeployment();
  });

  describe('Deployment', function () {
    it('should set reward token address', async function () {
      expect(await treasury.rewardToken()).to.equal(await rewardToken.getAddress());
    });

    it('should revert with zero token address', async function () {
      const TreasuryFactory = await ethers.getContractFactory('Treasury', owner);
      await expect(
        TreasuryFactory.deploy(ethers.ZeroAddress)
      ).to.be.revertedWith('Invalid token address');
    });
  });

  describe('Staking', function () {
    it('should record stake', async function () {
      await treasury.stake(player.address, ethers.parseEther('100'), { value: 0 });

      expect(await treasury.stakes(player.address)).to.equal(ethers.parseEther('100'));
    });

    it('should accumulate stakes', async function () {
      await treasury.stake(player.address, ethers.parseEther('100'), { value: 0 });
      await treasury.stake(player.address, ethers.parseEther('50'), { value: 0 });

      expect(await treasury.stakes(player.address)).to.equal(ethers.parseEther('150'));
    });

    it('should emit Staked event', async function () {
      await expect(
        treasury.stake(player.address, ethers.parseEther('100'), { value: 0 })
      ).to.emit(treasury, 'Staked');
    });

    it('should revert with zero player address', async function () {
      await expect(
        treasury.stake(ethers.ZeroAddress, ethers.parseEther('100'), { value: 0 })
      ).to.be.revertedWith('Invalid player');
    });

    it('should revert with zero amount', async function () {
      await expect(
        treasury.stake(player.address, 0, { value: 0 })
      ).to.be.revertedWith('Invalid stake amount');
    });

    it('should revert when paused', async function () {
      await treasury.pause();

      await expect(
        treasury.stake(player.address, ethers.parseEther('100'), { value: 0 })
      ).to.be.reverted;
    });
  });

  describe('Payout', function () {
    beforeEach(async function () {
      await rewardToken.approve(await treasury.getAddress(), ethers.parseEther('300'));
      await treasury.fundPool(ethers.parseEther('300'));
    });

    it('should pay reward tokens to a player', async function () {
      await treasury.payout(player.address, ethers.parseEther('100'));

      expect(await rewardToken.balanceOf(player.address)).to.equal(ethers.parseEther('100'));
      expect(await rewardToken.balanceOf(await treasury.getAddress())).to.equal(ethers.parseEther('200'));
    });

    it('should emit Payout event', async function () {
      await expect(
        treasury.payout(player.address, ethers.parseEther('100'))
      ).to.emit(treasury, 'Payout');
    });

    it('should revert with insufficient balance', async function () {
      await expect(
        treasury.payout(player.address, ethers.parseEther('500'))
      ).to.be.revertedWith('Insufficient reward pool');
    });

    it('should revert if not owner', async function () {
      await expect(
        treasury.connect(player).payout(player.address, ethers.parseEther('100'))
      ).to.be.reverted;
    });

    it('should revert with zero amount', async function () {
      await expect(
        treasury.payout(player.address, 0)
      ).to.be.revertedWith('Invalid payout amount');
    });

    it('should revert with zero recipient', async function () {
      await expect(
        treasury.payout(ethers.ZeroAddress, ethers.parseEther('100'))
      ).to.be.revertedWith('Invalid player');
    });

    it('should revert when paused', async function () {
      await treasury.pause();

      await expect(
        treasury.payout(player.address, ethers.parseEther('100'))
      ).to.be.reverted;
    });
  });

  describe('Fund Pool', function () {
    it('should fund the treasury reward pool', async function () {
      await rewardToken.approve(await treasury.getAddress(), ethers.parseEther('100'));
      await treasury.fundPool(ethers.parseEther('100'));

      expect(await rewardToken.balanceOf(await treasury.getAddress())).to.equal(ethers.parseEther('100'));
    });

    it('should revert if not owner', async function () {
      await rewardToken.connect(player).mint(player.address, ethers.parseEther('100'));
      await rewardToken.connect(player).approve(await treasury.getAddress(), ethers.parseEther('100'));

      await expect(
        treasury.connect(player).fundPool(ethers.parseEther('100'))
      ).to.be.reverted;
    });

    it('should revert with zero amount', async function () {
      await expect(
        treasury.fundPool(0)
      ).to.be.revertedWith('Invalid fund amount');
    });

    it('should revert when paused', async function () {
      await treasury.pause();
      await rewardToken.approve(await treasury.getAddress(), ethers.parseEther('100'));

      await expect(
        treasury.fundPool(ethers.parseEther('100'))
      ).to.be.reverted;
    });
  });

  describe('Emergency Withdraw', function () {
    beforeEach(async function () {
      await rewardToken.approve(await treasury.getAddress(), ethers.parseEther('300'));
      await treasury.fundPool(ethers.parseEther('300'));
    });

    it('should allow owner to withdraw reward tokens', async function () {
      await treasury.emergencyWithdraw(player.address, ethers.parseEther('100'));

      expect(await rewardToken.balanceOf(player.address)).to.equal(ethers.parseEther('100'));
      expect(await rewardToken.balanceOf(await treasury.getAddress())).to.equal(ethers.parseEther('200'));
    });

    it('should emit Withdrawn event when successful', async function () {
      await expect(
        treasury.emergencyWithdraw(player.address, ethers.parseEther('100'))
      ).to.emit(treasury, 'Withdrawn');
    });

    it('should revert if not owner', async function () {
      await expect(
        treasury.connect(player).emergencyWithdraw(other.address, ethers.parseEther('100'))
      ).to.be.reverted;
    });

    it('should revert with zero recipient', async function () {
      await expect(
        treasury.emergencyWithdraw(ethers.ZeroAddress, ethers.parseEther('100'))
      ).to.be.revertedWith('Invalid recipient');
    });

    it('should revert with zero amount', async function () {
      await expect(
        treasury.emergencyWithdraw(player.address, 0)
      ).to.be.revertedWith('Invalid withdrawal amount');
    });

    it('should revert with insufficient balance', async function () {
      await expect(
        treasury.emergencyWithdraw(player.address, ethers.parseEther('500'))
      ).to.be.revertedWith('Insufficient balance');
    });
  });

  describe('Pause Functionality', function () {
    it('should allow owner to pause', async function () {
      await treasury.pause();

      await expect(
        treasury.stake(player.address, ethers.parseEther('100'), { value: 0 })
      ).to.be.reverted;
    });

    it('should allow owner to unpause', async function () {
      await treasury.pause();
      await treasury.unpause();

      await expect(
        treasury.stake(player.address, ethers.parseEther('100'), { value: 0 })
      ).to.not.be.reverted;
    });

    it('should not allow non-owner to pause', async function () {
      await expect(
        treasury.connect(player).pause()
      ).to.be.reverted;
    });

    it('should not allow non-owner to unpause', async function () {
      await treasury.pause();

      await expect(
        treasury.connect(player).unpause()
      ).to.be.reverted;
    });
  });

  describe('Ownership', function () {
    it('should have owner set to deployer', async function () {
      expect(await treasury.owner()).to.equal(owner.address);
    });

    it('should allow owner to transfer ownership', async function () {
      await treasury.transferOwnership(player.address);
      expect(await treasury.owner()).to.equal(player.address);
    });

    it('should not allow non-owner to transfer ownership', async function () {
      await expect(
        treasury.connect(player).transferOwnership(other.address)
      ).to.be.reverted;
    });
  });
});
