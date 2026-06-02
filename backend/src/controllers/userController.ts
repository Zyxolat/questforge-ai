import { Request, Response } from 'express';
import { prisma } from '../services/chain';
import { normalizeWallet } from '../services/chain';
import {
  claimDailyCeloReward,
  DailyRewardAlreadyClaimedError,
  dailyRewardContract
} from '../services/dailyRewardService';
import { logger } from '../services/logger';

export async function getPlayerStats(req: Request, res: Response) {
  const wallet = req.query.wallet?.toString();
  if (!wallet) return res.status(400).json({ error: 'Wallet is required' });
  try {
    const normalized = normalizeWallet(wallet);
    const user = await prisma.user.findUnique({ where: { wallet: normalized } });
    const leaderboard = await prisma.user.findMany({ orderBy: [{ xp: 'desc' }], take: 10 });
    res.json({ user, leaderboard });
  } catch (error) {
    logger.error('Failed to fetch player stats', error, { wallet });
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
    logger.error('Failed to fetch progression', error, { wallet });
    res.status(500).json({ error: 'Unable to load progression' });
  }
}

export async function claimDailyLoginBonus(req: Request, res: Response) {
  const address = req.auth?.wallet;
  if (!address) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const result = await claimDailyCeloReward({ wallet: address });
    res.json(result);
  } catch (error) {
    if (error instanceof DailyRewardAlreadyClaimedError) {
      logger.warn('[DAILY-REWARD] Duplicate claim rejected by controller', {
        wallet: normalizeWallet(address),
        claimDate: dailyRewardContract.getUtcClaimDate()
      });
      return res.json({
        success: false,
        message: dailyRewardContract.duplicateMessage
      });
    }

    logger.error('Failed to claim daily CELO reward', error, { address });
    res.status(500).json({
      success: false,
      message: 'Unable to claim daily CELO reward.'
    });
  }
}
