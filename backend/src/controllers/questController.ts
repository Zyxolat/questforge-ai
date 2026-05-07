import { Request, Response } from 'express';
import { generateQuestPrompt, validateQuestProofPrompt, generateNPCDialogue } from '../services/openai';
import { prisma } from '../services/chain';

export async function generateQuest(req: Request, res: Response) {
  const wallet = req.body.wallet;
  const chain = req.body.chain || 'Celo';
  if (!wallet) return res.status(400).json({ error: 'Wallet is required' });
  try {
    const raw = await generateQuestPrompt(wallet, chain);
    const questText = raw;
    const quest = await prisma.quest.create({
      data: {
        title: `Forge Mission for ${wallet.slice(0, 8)}`,
        description: questText,
        metadata: { source: 'ai', chain },
        difficulty: 3,
        stakeAmount: 0.02,
        rewardAmount: 0.05,
        creator: wallet,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 6)
      }
    });
    res.json({ quest, ai: questText });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to generate quest' });
  }
}

export async function validateQuest(req: Request, res: Response) {
  const { wallet, questId, proofUri } = req.body;
  if (!wallet || !questId || !proofUri) return res.status(400).json({ error: 'Missing fields' });
  try {
    const quest = await prisma.quest.findUnique({ where: { id: questId } });
    if (!quest) return res.status(404).json({ error: 'Quest not found' });
    const raw = await validateQuestProofPrompt(wallet, quest.title, proofUri);
    res.json({ verification: raw, success: raw.includes('true') });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Validation failed' });
  }
}

export async function getDailyMissions(_req: Request, res: Response) {
  const missions = [
    { id: 'daily-01', title: 'Glowspire Caravan Escort', description: 'Protect the caravan on the Celo highway and trigger 3 onchain transfers.', reward: '50 $CELO' },
    { id: 'daily-02', title: 'Rune Puzzle of the Skyforge', description: 'Solve an AI riddle and submit a blockchain proof.', reward: 'Rare NFT shard' }
  ];
  res.json({ missions });
}

export async function getNPCDialogue(req: Request, res: Response) {
  const npcType = req.query.type?.toString() || 'Guild Master';
  const playerName = req.query.player?.toString() || 'Traveler';
  try {
    const dialogue = await generateNPCDialogue(npcType, playerName);
    res.json({ npcType, dialogue });
  } catch (error) {
    res.status(500).json({ error: 'NPC generation failed' });
  }
}
