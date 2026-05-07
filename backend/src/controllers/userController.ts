import { Request, Response } from 'express';
import { prisma } from '../services/chain';
import { normalizeWallet, upsertUser } from '../services/chain';

export async function getPlayerStats(req: Request, res: Response) {
  const wallet = req.query.wallet?.toString();
  if (!wallet) return res.status(400).json({ error: 'Wallet is required' });
  try {
    const normalized = normalizeWallet(wallet);
    const user = await upsertUser(normalized);
    const leaderboard = await prisma.user.findMany({ orderBy: [{ xp: 'desc' }], take: 10 });
    res.json({ user, leaderboard });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to fetch stats' });
  }
}

export async function getProgression(req: Request, res: Response) {
  const wallet = req.query.wallet?.toString();
  if (!wallet) return res.status(400).json({ error: 'Wallet required' });
  try {
    const user = await prisma.user.findUnique({ where: { wallet: normalizeWallet(wallet) }, include: { quests: true, rewards: true, nfts: true } });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const progression = {
      xp: user.xp,
      level: user.level,
      questCount: user.questCount,
      streak: user.streak,
      onchainActions: user.onchainActions,
      achievements: user.nfts.length
    };
    res.json({ progression });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to load progression' });
  }
}
