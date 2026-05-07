import { Request, Response } from 'express';
import { ethers } from 'ethers';
import { generateQuestPrompt, validateQuestProofPrompt, generateNPCDialogue } from '../services/openai';
import { prisma, normalizeWallet, upsertUser } from '../services/chain';
import { contracts, parseJSON } from '../services/contracts';

const QUEST_LIFETIME_MS = 1000 * 60 * 60 * 6;

export async function generateQuest(req: Request, res: Response) {
  const wallet = req.body.wallet;
  const chain = req.body.chain || 'Celo';

  if (!wallet) return res.status(400).json({ error: 'Wallet is required' });

  try {
    const raw = await generateQuestPrompt(wallet, chain);
    const aiData = parseJSON(raw) || {};
    const title = aiData.title || `Forge Mission for ${wallet.slice(0, 8)}`;
    const description = aiData.description || aiData.story || 'A magical mission awaits.';
    const stakeAmount = Number(aiData.stakeAmount) || 0.02;
    const rewardAmount = Number(aiData.rewardAmount) || 0.05;
    const difficulty = Number(aiData.difficulty) || 3;
    const objective = aiData.objective || aiData.task || 'Submit a proof of your journey.';
    const lore = aiData.lore || aiData.story || 'The Forge Master conjures a new challenge.';
    const metadataUri = `QuestForgeAI://quest/${title.replace(/\s+/g, '-')}`;
    const durationSeconds = 60 * 60 * 6;

    const tx = await contracts.forgeQuestManager.createQuest(
      title,
      metadataUri,
      ethers.parseEther(stakeAmount.toString()),
      ethers.parseEther(rewardAmount.toString()),
      durationSeconds
    );
    const receipt = await tx.wait();
    const log = receipt.logs.map((log) => {
      try {
        return contracts.forgeQuestManager.interface.parseLog(log);
      } catch {
        return null;
      }
    }).find((item) => item?.name === 'QuestCreated');
    const chainQuestId = log?.args?.questId ? BigInt(log.args.questId.toString()) : BigInt(0);

    const user = await upsertUser(normalizeWallet(wallet));
    const quest = await prisma.quest.create({
      data: {
        title,
        description,
        metadata: { ai: aiData, raw, chain },
        difficulty,
        questType: aiData.type || 'AI Quest',
        objective,
        lore,
        stakeAmount,
        rewardAmount,
        chainQuestId,
        status: 'AVAILABLE',
        creator: wallet,
        player: { connect: { id: user.id } },
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + QUEST_LIFETIME_MS)
      }
    });

    await prisma.transaction.create({
      data: {
        userId: user.id,
        wallet: normalizeWallet(wallet),
        type: 'QUEST_CREATED',
        chainId: Number(process.env.CELO_CHAIN_ID) || 44787,
        txHash: receipt.transactionHash,
        details: { chainQuestId: chainQuestId.toString(), stakeAmount, rewardAmount, title }
      }
    });

    res.json({ quest, chainQuestId: chainQuestId.toString(), ai: aiData });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to generate quest' });
  }
}

export async function startQuest(req: Request, res: Response) {
  const { wallet, questId } = req.body;
  if (!wallet || !questId) return res.status(400).json({ error: 'Missing wallet or questId' });

  try {
    const user = await upsertUser(normalizeWallet(wallet));
    const quest = await prisma.quest.update({
      where: { id: questId },
      data: {
        status: 'ACTIVE',
        player: { connect: { id: user.id } },
        startedAt: new Date()
      }
    });
    res.json({ quest });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not mark quest active' });
  }
}

export async function recordTransaction(req: Request, res: Response) {
  const { wallet, questId, txHash, type, chainId, details } = req.body;
  if (!wallet || !type || !txHash) return res.status(400).json({ error: 'Missing transaction payload' });
  try {
    const normalized = normalizeWallet(wallet);
    const user = await prisma.user.findUnique({ where: { wallet: normalized } });
    const data: any = { wallet: normalized, type, txHash, chainId: chainId || Number(process.env.CELO_CHAIN_ID) || 44787, details: details || {} };
    if (user) data.userId = user.id;
    if (questId) {
      const quest = await prisma.quest.findUnique({ where: { id: questId } });
      if (quest) {
        if (type === 'START_QUEST') data.details.quest = quest.title;
        await prisma.quest.update({ where: { id: questId }, data: { stakeTx: type === 'START_QUEST' ? txHash : quest.stakeTx, missionTx: type === 'MISSION_TX' ? txHash : quest.missionTx, proofTx: type === 'SUBMIT_PROOF' ? txHash : quest.proofTx } });
      }
    }
    const txRecord = await prisma.transaction.create({ data });
    res.json({ tx: txRecord });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not record transaction' });
  }
}

export async function submitQuest(req: Request, res: Response) {
  const { wallet, questId, proofUri, txHash } = req.body;
  if (!wallet || !questId || !proofUri) return res.status(400).json({ error: 'Missing required fields' });

  try {
    const quest = await prisma.quest.findUnique({ where: { id: questId } });
    if (!quest) return res.status(404).json({ error: 'Quest not found' });
    const validation = await validateQuestProofPrompt(wallet, quest.title, proofUri);
    const verified = /true/i.test(validation);
    const chainQuestId = quest.chainQuestId ?? BigInt(0);

    const verifyTx = await contracts.forgeQuestManager.verifyQuest(chainQuestId, verified);
    const receipt = await verifyTx.wait();

    await prisma.quest.update({
      where: { id: questId },
      data: {
        status: verified ? 'VERIFIED' : 'CANCELLED',
        proofTx: txHash || quest.proofTx,
        verificationTx: receipt.transactionHash,
        metadata: { ...quest.metadata, proofUri, aiValidation: validation }
      }
    });

    const user = await upsertUser(normalizeWallet(wallet));
    await prisma.transaction.create({
      data: {
        userId: user.id,
        wallet: normalizeWallet(wallet),
        type: verified ? 'QUEST_VERIFIED' : 'QUEST_FAILED',
        chainId: Number(process.env.CELO_CHAIN_ID) || 44787,
        txHash: receipt.transactionHash,
        details: { questId: quest.id, chainQuestId: chainQuestId.toString(), success: verified }
      }
    });

    if (verified) {
      const xpGain = Math.max(80, quest.difficulty * 160);
      const actionCount = 5;
      await contracts.reputation.rewardXP(wallet, xpGain, actionCount);
      await prisma.user.update({ where: { id: user.id }, data: { xp: { increment: xpGain }, level: { increment: Math.floor(xpGain / 200) }, questCount: { increment: 1 }, streak: { increment: 1 }, onchainActions: { increment: actionCount } } });
    }

    res.json({ verified, validation, verificationTx: receipt.transactionHash });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Quest verification failed' });
  }
}

export async function getDailyMissions(_req: Request, res: Response) {
  const missions = [
    { id: 'daily-quest-01', title: 'Shadow Courier', description: 'Send 0.01 CELO to a new ally and report the mission.', reward: '40 XP + rare shard' },
    { id: 'daily-quest-02', title: 'Mystic Relay', description: 'Trigger a mission transaction through the Council Treasury.', reward: '60 XP + bonus NFT chance' }
  ];
  res.json({ missions });
}

export async function getNPCDialogue(req: Request, res: Response) {
  const npcType = req.query.type?.toString() || 'Guild Master';
  const playerName = req.query.player?.toString() || 'Traveler';
  const wallet = req.query.wallet?.toString();
  try {
    const dialogue = await generateNPCDialogue(npcType, playerName);
    if (wallet) {
      const user = await upsertUser(normalizeWallet(wallet));
      await prisma.nPCConversation.create({
        data: {
          userId: user.id,
          npcType,
          messages: [{ role: 'npc', content: dialogue }, { role: 'player', content: `Hello ${playerName}` }]
        }
      });
    }
    res.json({ npcType, dialogue });
  } catch (error) {
    res.status(500).json({ error: 'NPC generation failed' });
  }
}

export async function getActiveQuests(req: Request, res: Response) {
  const wallet = req.query.wallet?.toString();
  if (!wallet) return res.status(400).json({ error: 'Wallet is required' });
  const normalized = normalizeWallet(wallet);
  try {
    const user = await prisma.user.findUnique({ where: { wallet: normalized } });
    if (!user) return res.status(404).json({ error: 'Player not found' });
    const quests = await prisma.quest.findMany({ where: { playerId: user.id }, orderBy: { createdAt: 'desc' } });
    res.json({ quests });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to load active quests' });
  }
}
