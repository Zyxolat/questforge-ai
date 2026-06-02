import crypto from 'crypto';
import { ethers } from 'ethers';
import { Prisma } from '@prisma/client';
import { env } from '../config/env';
import { normalizeWallet, prisma } from './chain';
import { contracts } from './contracts';
import { logger } from './logger';

const DAILY_REWARD_AMOUNT_CELO = '0.0001';
const DAILY_REWARD_AMOUNT_WEI = ethers.parseEther(DAILY_REWARD_AMOUNT_CELO);
const PROCESSING_LOCK_WINDOW_MS = 10 * 60 * 1000;
const DUPLICATE_MESSAGE = "You have already claimed today's reward. Come back tomorrow.";

type DailyRewardClaimRow = {
  id: string;
  userId: string;
  wallet: string;
  claimDate: string;
  amountCelo: number;
  txHash: string | null;
  status: 'PROCESSING' | 'PAID' | 'FAILED';
  processingStartedAt: Date;
  paidAt: Date | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type DailyRewardUserRow = {
  id: string;
  wallet: string;
  lastDailyClaimAt: Date | null;
  dailyClaimStreak: number;
  totalClaimedCelo: number;
};

export class DailyRewardAlreadyClaimedError extends Error {
  constructor() {
    super(DUPLICATE_MESSAGE);
    this.name = 'DailyRewardAlreadyClaimedError';
  }
}

export class DailyRewardPayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DailyRewardPayoutError';
  }
}

function getUtcClaimDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getNextUtcMidnight(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
}

function wasYesterdayUtc(previous: Date | null, claimDate: string) {
  if (!previous) {
    return false;
  }

  const previousClaimDate = getUtcClaimDate(previous);
  const claimDayStart = new Date(`${claimDate}T00:00:00.000Z`);
  const yesterday = new Date(claimDayStart.getTime() - 24 * 60 * 60 * 1000);
  return previousClaimDate === getUtcClaimDate(yesterday);
}

async function estimateTransferCost(to: string) {
  const signer = contracts.dailyRewardSigner;
  if (!signer) {
    throw new DailyRewardPayoutError('Daily reward treasury signer is not configured');
  }

  const [balance, gasLimit, feeData] = await Promise.all([
    contracts.provider.getBalance(signer.address),
    signer.estimateGas({ to, value: DAILY_REWARD_AMOUNT_WEI }),
    contracts.provider.getFeeData()
  ]);
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
  const estimatedGasCost = gasLimit * gasPrice;
  const requiredBalance = DAILY_REWARD_AMOUNT_WEI + estimatedGasCost;

  return {
    signer,
    treasuryWallet: signer.address,
    balance,
    gasLimit,
    gasPrice,
    estimatedGasCost,
    requiredBalance
  };
}

async function reserveDailyClaim(wallet: string, claimDate: string) {
  const staleProcessingBefore = new Date(Date.now() - PROCESSING_LOCK_WINDOW_MS);

  return prisma.$transaction(
    async (tx) => {
      const user = await tx.user.upsert({
        where: { wallet },
        update: {},
        create: { wallet }
      });
      const [rewardUser] = await tx.$queryRaw<DailyRewardUserRow[]>`
        SELECT
          id,
          wallet,
          "lastDailyClaimAt",
          "dailyClaimStreak",
          "totalClaimedCelo"
        FROM "User"
        WHERE id = ${user.id}
        LIMIT 1
      `;

      if (!rewardUser) {
        throw new DailyRewardPayoutError('Daily reward user record was not available');
      }

      const alreadyClaimedToday = rewardUser.lastDailyClaimAt
        ? getUtcClaimDate(rewardUser.lastDailyClaimAt) === claimDate
        : false;
      if (alreadyClaimedToday) {
        throw new DailyRewardAlreadyClaimedError();
      }

      const claimId = crypto.randomUUID();
      const now = new Date();
      const [claim] = await tx.$queryRaw<DailyRewardClaimRow[]>`
        INSERT INTO "DailyRewardClaim" (
          id,
          "userId",
          wallet,
          "claimDate",
          "amountCelo",
          status,
          "processingStartedAt",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          ${claimId},
          ${rewardUser.id},
          ${wallet},
          ${claimDate},
          ${Number(DAILY_REWARD_AMOUNT_CELO)},
          'PROCESSING'::"DailyRewardClaimStatus",
          ${now},
          ${now},
          ${now}
        )
        ON CONFLICT ("userId", "claimDate")
        DO UPDATE SET
          status = 'PROCESSING'::"DailyRewardClaimStatus",
          "txHash" = NULL,
          "failureReason" = NULL,
          "processingStartedAt" = EXCLUDED."processingStartedAt",
          "updatedAt" = EXCLUDED."updatedAt"
        WHERE
          (
            "DailyRewardClaim".status = 'FAILED'::"DailyRewardClaimStatus"
            AND "DailyRewardClaim"."txHash" IS NULL
          )
          OR (
            "DailyRewardClaim".status = 'PROCESSING'::"DailyRewardClaimStatus"
            AND "DailyRewardClaim"."txHash" IS NULL
            AND "DailyRewardClaim"."processingStartedAt" < ${staleProcessingBefore}
          )
        RETURNING *
      `;

      if (!claim) {
        logger.warn('[DAILY-REWARD] Duplicate or in-flight daily claim rejected', {
          userId: user.id,
          wallet,
          claimDate
        });
        throw new DailyRewardAlreadyClaimedError();
      }

      return { user: rewardUser, claim };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

async function markClaimFailed(claimId: string, error: unknown, txHash?: string) {
  const message = error instanceof Error ? error.message : String(error);

  if (txHash) {
    await prisma.$executeRaw`
      UPDATE "DailyRewardClaim"
      SET
        "txHash" = ${txHash},
        "failureReason" = ${`Confirmation pending or failed: ${message}`},
        "updatedAt" = ${new Date()}
      WHERE id = ${claimId}
    `;
    return;
  }

  await prisma.$executeRaw`
    UPDATE "DailyRewardClaim"
    SET
      status = 'FAILED'::"DailyRewardClaimStatus",
      "failureReason" = ${message},
      "updatedAt" = ${new Date()}
    WHERE id = ${claimId}
  `;
}

export async function claimDailyCeloReward(input: { wallet: string }) {
  const wallet = normalizeWallet(input.wallet);
  const claimDate = getUtcClaimDate();
  const nextAvailableAt = getNextUtcMidnight();

  logger.info('[DAILY-REWARD] Claim requested', {
    wallet,
    claimDate,
    amountCelo: DAILY_REWARD_AMOUNT_CELO
  });

  const { user, claim } = await reserveDailyClaim(wallet, claimDate);
  let txHash: string | undefined;

  try {
    const transferCost = await estimateTransferCost(wallet);
    if (transferCost.balance < transferCost.requiredBalance) {
      throw new DailyRewardPayoutError('Daily reward treasury balance is insufficient for payout and gas');
    }

    logger.info('[DAILY-REWARD] Treasury balance verified', {
      userId: user.id,
      wallet,
      claimId: claim.id,
      claimDate,
      treasuryWallet: transferCost.treasuryWallet,
      amountCelo: DAILY_REWARD_AMOUNT_CELO,
      balanceWei: transferCost.balance.toString(),
      requiredBalanceWei: transferCost.requiredBalance.toString(),
      estimatedGasCostWei: transferCost.estimatedGasCost.toString()
    });

    const tx = await transferCost.signer.sendTransaction({
      to: wallet,
      value: DAILY_REWARD_AMOUNT_WEI
    });
    txHash = tx.hash;
    await prisma.$executeRaw`
      UPDATE "DailyRewardClaim"
      SET
        "txHash" = ${txHash},
        "failureReason" = NULL,
        "updatedAt" = ${new Date()}
      WHERE id = ${claim.id}
    `;

    logger.info('[DAILY-REWARD] Payout transaction submitted', {
      userId: user.id,
      wallet,
      claimId: claim.id,
      claimDate,
      txHash,
      amountCelo: DAILY_REWARD_AMOUNT_CELO
    });

    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new DailyRewardPayoutError('Daily reward payout transaction was not confirmed successfully');
    }
    if (!txHash) {
      throw new DailyRewardPayoutError('Daily reward payout transaction hash was missing after confirmation');
    }
    const confirmedTxHash = txHash;

    const paidAt = new Date();
    const result = await prisma.$transaction(
      async (txClient) => {
        const [updatedClaim] = await txClient.$queryRaw<DailyRewardClaimRow[]>`
          UPDATE "DailyRewardClaim"
          SET
            status = 'PAID'::"DailyRewardClaimStatus",
            "paidAt" = ${paidAt},
            "failureReason" = NULL,
            "updatedAt" = ${paidAt}
          WHERE
            id = ${claim.id}
            AND status = 'PROCESSING'::"DailyRewardClaimStatus"
            AND "txHash" = ${confirmedTxHash}
          RETURNING *
        `;

        if (!updatedClaim) {
          const [existingClaim] = await txClient.$queryRaw<DailyRewardClaimRow[]>`
            SELECT *
            FROM "DailyRewardClaim"
            WHERE id = ${claim.id}
            LIMIT 1
          `;
          if (existingClaim?.status === 'PAID') {
            throw new DailyRewardAlreadyClaimedError();
          }
          throw new DailyRewardPayoutError('Daily reward claim was no longer available to finalize');
        }

        const [currentUser] = await txClient.$queryRaw<DailyRewardUserRow[]>`
          SELECT
            id,
            wallet,
            "lastDailyClaimAt",
            "dailyClaimStreak",
            "totalClaimedCelo"
          FROM "User"
          WHERE id = ${user.id}
          LIMIT 1
        `;
        if (!currentUser) {
          throw new DailyRewardPayoutError('Daily reward user record was not available during finalization');
        }
        const newStreak = wasYesterdayUtc(currentUser.lastDailyClaimAt, claimDate)
          ? currentUser.dailyClaimStreak + 1
          : 1;

        const [updatedUser] = await txClient.$queryRaw<DailyRewardUserRow[]>`
          UPDATE "User"
          SET
            "lastDailyClaimAt" = ${paidAt},
            "dailyClaimStreak" = ${newStreak},
            "totalClaimedCelo" = "totalClaimedCelo" + ${Number(DAILY_REWARD_AMOUNT_CELO)},
            "updatedAt" = ${paidAt}
          WHERE id = ${user.id}
          RETURNING
            id,
            wallet,
            "lastDailyClaimAt",
            "dailyClaimStreak",
            "totalClaimedCelo"
        `;
        if (!updatedUser) {
          throw new DailyRewardPayoutError('Daily reward user record was not updated');
        }

        await txClient.reward.create({
          data: {
            userId: user.id,
            type: 'daily_celo',
            amount: Number(DAILY_REWARD_AMOUNT_CELO),
            tokenTx: confirmedTxHash
          }
        });

        await txClient.transaction.create({
          data: {
            userId: user.id,
            wallet,
            type: 'daily_reward_payout',
            chainId: env.CELO_CHAIN_ID,
            txHash: confirmedTxHash,
            details: {
              claimId: claim.id,
              claimDate,
              amountCelo: DAILY_REWARD_AMOUNT_CELO,
              treasuryWallet: transferCost.treasuryWallet
            }
          }
        });

        return { updatedClaim, updatedUser };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    logger.info('[DAILY-REWARD] Payout confirmed and persisted', {
      userId: user.id,
      wallet,
      claimId: claim.id,
      claimDate,
      txHash,
      blockNumber: receipt.blockNumber,
      amountCelo: DAILY_REWARD_AMOUNT_CELO,
      dailyClaimStreak: result.updatedUser.dailyClaimStreak,
      totalClaimedCelo: result.updatedUser.totalClaimedCelo
    });

    return {
      success: true,
      message: 'Daily CELO reward claimed!',
      reward: {
        amountCelo: DAILY_REWARD_AMOUNT_CELO,
        txHash: result.updatedClaim.txHash!,
        claimedAt: result.updatedClaim.paidAt!.toISOString(),
        claimDate,
        nextAvailableAt: nextAvailableAt.toISOString(),
        dailyClaimStreak: result.updatedUser.dailyClaimStreak,
        totalClaimedCelo: Number(result.updatedUser.totalClaimedCelo.toFixed(4))
      },
      user: {
        id: result.updatedUser.id,
        wallet: result.updatedUser.wallet,
        dailyClaimStreak: result.updatedUser.dailyClaimStreak,
        totalClaimedCelo: Number(result.updatedUser.totalClaimedCelo.toFixed(4)),
        lastDailyClaimAt: result.updatedUser.lastDailyClaimAt?.toISOString() ?? null
      }
    };
  } catch (error) {
    await markClaimFailed(claim.id, error, txHash);
    logger.error('[DAILY-REWARD] Claim payout failed', error, {
      userId: user.id,
      wallet,
      claimId: claim.id,
      claimDate,
      txHash: txHash ?? null,
      amountCelo: DAILY_REWARD_AMOUNT_CELO
    });
    throw error;
  }
}

export const dailyRewardContract = {
  amountCelo: DAILY_REWARD_AMOUNT_CELO,
  duplicateMessage: DUPLICATE_MESSAGE,
  getUtcClaimDate,
  getNextUtcMidnight
};
