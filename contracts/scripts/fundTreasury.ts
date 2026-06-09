import hre from 'hardhat';
import '@nomicfoundation/hardhat-ethers';
import { Treasury__factory } from '../typechain-types';

const { ethers } = hre;

/**
 * Fund the Treasury contract with native currency (CELO)
 * 
 * This script sends CELO to the Treasury contract to enable quest reward reservations.
 * 
 * Usage:
 *   npx hardhat run scripts/fundTreasury.ts --network celo
 * 
 * Environment variables:
 *   TREASURY_ADDRESS - Address of deployed Treasury contract
 *   FUND_AMOUNT - Amount of CELO to send (in units, e.g., "10" for 10 CELO)
 *                 Default: 5 CELO
 *   PRIVATE_KEY - Deployer/owner private key for signing transaction
 */

async function main() {
  const networkName = hre.network.name;
  
  if (!['celo', 'localhost', 'hardhat'].includes(networkName)) {
    throw new Error(`Unsupported network: ${networkName}`);
  }

  // Get parameters from environment
  const treasuryAddress = process.env.TREASURY_ADDRESS?.trim();
  if (!treasuryAddress) {
    throw new Error('TREASURY_ADDRESS environment variable is required');
  }

  const fundAmountStr = (process.env.FUND_AMOUNT || '5').trim();
  const fundAmount = ethers.parseEther(fundAmountStr);

  // Get signer
  const signers = await ethers.getSigners();
  const signer = signers[0];

  if (!signer) {
    throw new Error('No signer available for this network');
  }

  const signerAddress = await signer.getAddress();

  console.log('\n=====================');
  console.log(' FUND TREASURY ');
  console.log('=====================');
  console.log('Network:', networkName);
  console.log('Signer:', signerAddress);
  console.log('Treasury Address:', treasuryAddress);
  console.log('Fund Amount:', fundAmountStr, 'CELO');

  // Verify Treasury contract exists and is the right type
  const code = await ethers.provider.getCode(treasuryAddress);
  if (code === '0x') {
    throw new Error(`No contract found at Treasury address: ${treasuryAddress}`);
  }

  // Get Treasury instance
  const treasury = Treasury__factory.connect(treasuryAddress, signer);

  // Check current balance
  const currentBalance = await ethers.provider.getBalance(treasuryAddress);
  console.log('\n📊 Current Treasury State:');
  console.log('   Balance:', ethers.formatEther(currentBalance), 'CELO');

  try {
    const obligations = await treasury.obligations();
    console.log('   Obligations:', ethers.formatEther(obligations), 'CELO');
    console.log('   Available Liquidity:', ethers.formatEther(currentBalance - obligations), 'CELO');
  } catch {
    console.log('   (Could not read obligations)');
  }

  // Check signer has enough balance
  const signerBalance = await ethers.provider.getBalance(signerAddress);
  if (signerBalance < fundAmount) {
    throw new Error(
      `Insufficient signer balance. Have ${ethers.formatEther(signerBalance)} CELO, ` +
      `need ${ethers.formatEther(fundAmount)} CELO`
    );
  }

  // Call fundNativeRewardPool
  console.log('\n⏳ Funding Treasury...');
  console.log('   Sending transaction to fundNativeRewardPool()...');

  try {
    const tx = await treasury.fundNativeRewardPool({ value: fundAmount });
    console.log('   Transaction Hash:', tx.hash);
    console.log('   Waiting for confirmation...');

    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error('Transaction reverted or failed');
    }

    console.log('   Block Number:', receipt.blockNumber);
    console.log('   Gas Used:', receipt.gasUsed.toString());

    // Check new balance
    const newBalance = await ethers.provider.getBalance(treasuryAddress);
    console.log('\n✅ Treasury Funded Successfully!');
    console.log('   Old Balance:', ethers.formatEther(currentBalance), 'CELO');
    console.log('   New Balance:', ethers.formatEther(newBalance), 'CELO');
    console.log('   Amount Added:', ethers.formatEther(fundAmount), 'CELO');

    // Check new liquidity
    try {
      const newLiquidity = await treasury.availableRewardLiquidity();
      console.log('   Available Liquidity:', ethers.formatEther(newLiquidity), 'CELO');
    } catch {
      console.log('   (Could not read new liquidity)');
    }
  } catch (error) {
    console.error('\n❌ Funding Failed:');
    if (error instanceof Error) {
      console.error('   Error:', error.message);
      if (error.message.includes('AccessControl')) {
        console.error('   → Signer is not the Treasury owner');
      } else if (error.message.includes('Pausable')) {
        console.error('   → Treasury is paused');
      }
    } else {
      console.error('   Error:', error);
    }
    throw error;
  }

  console.log('\n=====================\n');
}

main().catch((err) => {
  console.error('\n❌ FAILED');
  console.error(err);
  process.exit(1);
});
