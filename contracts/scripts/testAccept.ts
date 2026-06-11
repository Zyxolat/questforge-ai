import hre from 'hardhat';
import { ForgeQuestManager__factory } from '../typechain-types';
import fs from 'fs';
import type { Signer } from 'ethers';

async function main() {
  const deployments = JSON.parse(fs.readFileSync('deployments/localhost-addresses.json', 'utf8'));
  const forgeAddress = deployments.FORGE_QUEST_MANAGER_ADDRESS;

  let creator: Signer;
  let accepter: Signer;
  const signers: Signer[] = (hre.ethers && typeof hre.ethers.getSigners === 'function') ? await hre.ethers.getSigners() : [];
  if (signers && signers.length >= 2) {
    creator = signers[0];
    accepter = signers[1];
  } else {
    const accounts = await hre.network.provider.request({ method: 'eth_accounts', params: [] }) as string[];
    if (accounts && accounts.length >= 2) {
      creator = hre.ethers.provider.getSigner(accounts[0]);
      accepter = hre.ethers.provider.getSigner(accounts[1]);
    } else {
      throw new Error('No signers or accounts available on this network. Provide accounts in hardhat config or environment.');
    }
  }
  console.log('Creator', await creator.getAddress());
  console.log('Accepter', await accepter.getAddress());

  const fqm = new ForgeQuestManager__factory(creator).attach(forgeAddress);

  console.log('Creating quest (creator)...');
  const tx = await fqm.createQuest(
    'Test Quest',
    'data:application/json;base64,' + Buffer.from(JSON.stringify({ title: 'Test Quest' })).toString('base64'),
    hre.ethers.parseEther('0.01'),
    100n,
    3600n
  );

  const receipt = await tx.wait();
  console.log('Create tx mined:', tx.hash);

  const createdLog = receipt.logs.map((l) => {
    try { return fqm.interface.parseLog(l); } catch { return null; }
  }).find(Boolean);

  if (!createdLog) {
    console.error('QuestCreated event not found in create tx');
    return;
  }

  const questId = BigInt(createdLog!.args.questId.toString());
  console.log('Quest created onchain id:', questId.toString());

  // Now accept from a different signer
  const fqmAccepter = new ForgeQuestManager__factory(accepter).attach(forgeAddress);
  console.log('Accepting quest from accepter with fee...');
  const acceptTx = await fqmAccepter.acceptQuest(questId, { value: hre.ethers.parseEther('0.001') });
  const acceptReceipt = await acceptTx.wait();
  console.log('Accept tx mined:', acceptTx.hash);

  const acceptLog = acceptReceipt.logs.map((l) => {
    try { return fqmAccepter.interface.parseLog(l); } catch { return null; }
  }).find(Boolean);

  if (!acceptLog) {
    console.error('QuestAccepted event not found in accept tx');
    return;
  }

  console.log('QuestAccepted event:', acceptLog!.name, acceptLog!.args);

  // Now attempt to decode logs using backend eventDecoder
  try {
    // Ensure backend env matches the deployed addresses so the decoder can map contract address -> decoder
    process.env.FORGE_QUEST_MANAGER_ADDRESS = forgeAddress;
    process.env.REWARD_NFT_ADDRESS = deployments.REWARD_NFT_ADDRESS;
    process.env.TREASURY_ADDRESS = deployments.TREASURY_ADDRESS;

    try {
      const backendEnv = await import('../../backend/dist/config/env');
      if (typeof backendEnv.initializeEnvironment === 'function') {
        backendEnv.initializeEnvironment();
      }
      const eventDecoderModule = await import('../../backend/dist/services/eventDecoder');
      const { eventDecoder } = eventDecoderModule;
      const decoded = eventDecoder.decodeLogs(acceptReceipt.logs, new Date());
      console.log('Decoded events via backend.eventDecoder:', decoded);
    } catch {
      console.warn('Backend event decoder not available for this test');
    }
  } catch (err) {
    console.warn('Failed to run backend eventDecoder:', err?.message || err);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
