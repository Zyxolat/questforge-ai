import { Request, Response } from 'express';
import { prisma } from '../services/chain';
import { normalizeWallet } from '../services/chain';
import { logger } from '../services/logger';

const DAILY_LOGIN_BONUSES = [
  { day: 1, xp: 100 },
  { day: 2, xp: 150 },
  { day: 3, xp: 200 },
  { day: 7, xp: 500 },
];

function getLoginBonusForDay(day: number) {
  // Find bonus for this day, or use the highest available if day exceeds all tiers
  return DAILY_LOGIN_BONUSES.find(b => b.day === day) || DAILY_LOGIN_BONUSES[DAILY_LOGIN_BONUSES.length - 1];
}

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
    const normalized = normalizeWallet(address);
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

    // Check if user already claimed bonus today
    const todayActivity = await prisma.dailyActivity.findUnique({
      where: { userId_date: { userId: address, date: today } },
    }).catch(() => null);

    if (todayActivity?.rewardsEarned !== undefined && todayActivity.rewardsEarned > 0) {
      // Already claimed today
      return res.status(400).json({
        error: 'Already claimed daily bonus',
        message: 'Return tomorrow for your next bonus',
        nextAvailable: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      });
    }

    // Get or create user
    let user = await prisma.user.findUnique({ where: { wallet: normalized } });
    if (!user) {
      user = await prisma.user.create({
        data: { wallet: normalized }
      });
    }

    // Calculate streak - check if last completion was yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];
    
    const yesterdayActivity = await prisma.dailyActivity.findUnique({
      where: { userId_date: { userId: user.id, date: yesterdayStr } }
    }).catch(() => null);

    let newStreak = user.streak + 1;
    if (!yesterdayActivity) {
      newStreak = 1; // Streak broken, restart
    }

    // Get bonus XP based on current streak
    const bonus = getLoginBonusForDay(newStreak);
    const xpReward = bonus.xp;

    // Update or create daily activity
    await prisma.dailyActivity.upsert({
      where: { userId_date: { userId: user.id, date: today } },
      create: {
        userId: user.id,
        date: today,
        xpEarned: xpReward,
        rewardsEarned: 0.05, // Small token reward to mark bonus claimed
        questsAttempted: 0,
        questsCompleted: 0
      },
      update: {
        xpEarned: xpReward,
        rewardsEarned: 0.05
      }
    });

    // Update user XP and streak
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        xp: { increment: xpReward },
        streak: newStreak,
        lastQuestCompletedAt: new Date()
      }
    });

    res.json({
      success: true,
      message: `Daily login bonus claimed!`,
      bonus: {
        xp: xpReward,
        streak: newStreak,
        nextDay: newStreak + 1
      },
      user: {
        xp: updatedUser.xp,
        streak: updatedUser.streak,
        level: updatedUser.level
      }
    });
  } catch (error) {
    logger.error('Failed to claim daily login bonus', error, { address });
    res.status(500).json({ error: 'Unable to claim bonus' });
  }
}
