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
const DAILY_REWARD_PRIORITY_FEE_CAP_WEI = ethers.parseUnits('0.5', 'gwei');

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
  readonly statusCode = 409;

  constructor() {
    super(DUPLICATE_MESSAGE);
    this.name = 'DailyRewardAlreadyClaimedError';
  }
}

export class DailyRewardPayoutError extends Error {
  readonly statusCode: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode = 503, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DailyRewardPayoutError';
    this.statusCode = statusCode;
    this.details = details;
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
    throw new DailyRewardPayoutError('Daily reward treasury signer is not configured', 503, {
      step: 'signer_configuration'
    });
  }

  try {
    const [balance, gasLimit, feeData] = await Promise.all([
      contracts.provider.getBalance(signer.address),
      signer.estimateGas({ to, value: DAILY_REWARD_AMOUNT_WEI }),
      contracts.provider.getFeeData()
    ]);
    const legacyGasPrice = feeData.gasPrice ?? 0n;
    const suggestedPriorityFee = feeData.maxPriorityFeePerGas ?? legacyGasPrice;
    const priorityFeePerGas =
      suggestedPriorityFee > DAILY_REWARD_PRIORITY_FEE_CAP_WEI ? DAILY_REWARD_PRIORITY_FEE_CAP_WEI : suggestedPriorityFee;
    const suggestedMaxFee = feeData.maxFeePerGas ?? (legacyGasPrice > 0n ? legacyGasPrice * 2n : priorityFeePerGas);
    const maxFeePerGas = suggestedMaxFee < priorityFeePerGas ? priorityFeePerGas : suggestedMaxFee;
    const usesEip1559Fees = feeData.maxFeePerGas != null || feeData.maxPriorityFeePerGas != null;
    const txFeeOverrides = usesEip1559Fees
      ? {
          maxPriorityFeePerGas: priorityFeePerGas,
          maxFeePerGas
        }
      : {
          gasPrice: legacyGasPrice > 0n ? legacyGasPrice : maxFeePerGas
        };
    const estimatedGasCost = gasLimit * (usesEip1559Fees ? maxFeePerGas : legacyGasPrice || maxFeePerGas);
    const requiredBalance = DAILY_REWARD_AMOUNT_WEI + estimatedGasCost;

    return {
      signer,
      treasuryWallet: signer.address,
      balance,
      gasLimit,
      txFeeOverrides,
      estimatedGasCost,
      feeMode: usesEip1559Fees ? 'eip1559' : 'legacy',
      priorityFeePerGas: usesEip1559Fees ? priorityFeePerGas : null,
      maxFeePerGas: usesEip1559Fees ? maxFeePerGas : null,
      requiredBalance
    };
  } catch (error) {
    throw new DailyRewardPayoutError('Unable to query Celo RPC provider for payout cost', 503, {
      step: 'provider_query',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    });
  }
}

async function findDailyRewardClaim(wallet: string, claimDate: string) {
  const [claim] = await prisma.$queryRaw<DailyRewardClaimRow[]>`
    SELECT
      id,
      "userId",
      wallet,
      "claimDate",
      "amountCelo",
      "txHash",
      status,
      "processingStartedAt",
      "paidAt",
      "failureReason",
      "createdAt",
      "updatedAt"
    FROM "DailyRewardClaim"
    WHERE wallet = ${wallet}
      AND "claimDate" = ${claimDate}
    LIMIT 1
  `;

  return claim ?? null;
}

async function markClaimFailed(
  claimId: string,
  error: unknown,
  txHash?: string,
  options?: { confirmedOnchainFailure?: boolean }
) {
  const message = error instanceof Error ? error.message : String(error);

  if (txHash && options?.confirmedOnchainFailure) {
    await prisma.$executeRaw`
      UPDATE "DailyRewardClaim"
      SET
        status = 'FAILED'::"DailyRewardClaimStatus",
        "txHash" = NULL,
        "failureReason" = ${`Confirmed onchain failure: ${message}`},
        "updatedAt" = ${new Date()}
      WHERE id = ${claimId}
    `;
    return;
  }

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
      "txHash" = NULL,
      "failureReason" = ${message},
      "updatedAt" = ${new Date()}
    WHERE id = ${claimId}
  `;
}

async function resumeExistingClaimIfPossible(input: {
  claim: DailyRewardClaimRow;
  claimDate: string;
  nextAvailableAt: Date;
}) {
  if (!input.claim.txHash) {
    if (input.claim.status === 'PROCESSING') {
      const claimAgeMs = Date.now() - input.claim.processingStartedAt.getTime();
      if (claimAgeMs < PROCESSING_LOCK_WINDOW_MS) {
        throw new DailyRewardPayoutError('A daily reward claim is already in progress. Please try again shortly.', 202, {
          claimId: input.claim.id,
          claimDate: input.claimDate,
          nextAvailableAt: input.nextAvailableAt.toISOString(),
          state: 'processing'
        });
      }
    }
    return null;
  }

  const receipt = await contracts.provider.getTransactionReceipt(input.claim.txHash);
  if (!receipt) {
    throw new DailyRewardPayoutError('Previous daily reward payout is still pending onchain. Please try again later.', 202, {
      claimId: input.claim.id,
      claimDate: input.claimDate,
      nextAvailableAt: input.nextAvailableAt.toISOString(),
      txHash: input.claim.txHash,
      state: 'pending'
    });
  }

  if (receipt.status !== 1) {
    await markClaimFailed(input.claim.id, new Error('Previous payout transaction reverted onchain'), input.claim.txHash, {
      confirmedOnchainFailure: true
    });
    logger.warn('[DAILY-REWARD] Existing broadcast claim failed onchain and was reset for retry', {
      claimId: input.claim.id,
      wallet: input.claim.wallet,
      claimDate: input.claimDate,
      txHash: input.claim.txHash,
      blockNumber: receipt.blockNumber
    });
    return null;
  }

  const [user] = await prisma.$queryRaw<DailyRewardUserRow[]>`
    SELECT
      id,
      wallet,
      "lastDailyClaimAt",
      "dailyClaimStreak",
      "totalClaimedCelo"
    FROM "User"
    WHERE id = ${input.claim.userId}
    FOR UPDATE
    LIMIT 1
  `;

  if (!user) {
    throw new DailyRewardPayoutError('Daily reward user record was not available during claim recovery', 503, {
      claimId: input.claim.id,
      claimDate: input.claimDate,
      txHash: input.claim.txHash ?? 'unknown'
    });
  }

  const paidAt = new Date();
  const confirmedTxHash = input.claim.txHash;
  if (!confirmedTxHash) {
    throw new DailyRewardPayoutError('Recovered daily reward claim was missing its transaction hash', 503, {
      claimId: input.claim.id,
      claimDate: input.claimDate
    });
  }
  const finalized = await prisma.$transaction(
    async (txClient) => {
      const [updatedClaim] = await txClient.$queryRaw<DailyRewardClaimRow[]>`
        UPDATE "DailyRewardClaim"
        SET
          status = 'PAID'::"DailyRewardClaimStatus",
          "paidAt" = ${paidAt},
          "failureReason" = NULL,
          "updatedAt" = ${paidAt}
        WHERE
          id = ${input.claim.id}
          AND "txHash" = ${confirmedTxHash}
          AND status IN ('PROCESSING'::"DailyRewardClaimStatus", 'FAILED'::"DailyRewardClaimStatus")
        RETURNING *
      `;

      if (!updatedClaim) {
        const [existingClaim] = await txClient.$queryRaw<DailyRewardClaimRow[]>`
          SELECT *
          FROM "DailyRewardClaim"
          WHERE id = ${input.claim.id}
          LIMIT 1
        `;
        if (existingClaim?.status === 'PAID') {
          throw new DailyRewardAlreadyClaimedError();
        }
        throw new DailyRewardPayoutError('Daily reward claim was no longer available to finalize', 503, {
          claimId: input.claim.id,
          claimDate: input.claimDate,
          txHash: confirmedTxHash
        });
      }

      const newStreak = wasYesterdayUtc(user.lastDailyClaimAt, input.claimDate) ? user.dailyClaimStreak + 1 : 1;

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
        throw new DailyRewardPayoutError('Daily reward user record was not updated during claim recovery', 503, {
          claimId: input.claim.id,
          claimDate: input.claimDate,
          txHash: confirmedTxHash
        });
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
          wallet: user.wallet,
          type: 'daily_reward_payout',
          chainId: env.CELO_CHAIN_ID,
          txHash: confirmedTxHash,
          details: {
            claimId: input.claim.id,
            claimDate: input.claimDate,
            amountCelo: DAILY_REWARD_AMOUNT_CELO,
            treasuryWallet: contracts.dailyRewardSigner?.address ?? 'unknown'
          }
        }
      });

      return { updatedClaim, updatedUser };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );

  logger.info('[DAILY-REWARD] Existing payout transaction finalized on retry', {
    userId: user.id,
    wallet: user.wallet,
    claimId: input.claim.id,
    claimDate: input.claimDate,
    txHash: confirmedTxHash,
    blockNumber: receipt.blockNumber,
    dailyClaimStreak: finalized.updatedUser.dailyClaimStreak,
    totalClaimedCelo: finalized.updatedUser.totalClaimedCelo
  });

  return {
    success: true,
    message: 'Daily CELO reward claimed!',
    reward: {
      amountCelo: DAILY_REWARD_AMOUNT_CELO,
      txHash: finalized.updatedClaim.txHash!,
      claimedAt: finalized.updatedClaim.paidAt!.toISOString(),
      claimDate: input.claimDate,
      nextAvailableAt: input.nextAvailableAt.toISOString(),
      dailyClaimStreak: finalized.updatedUser.dailyClaimStreak,
      totalClaimedCelo: Number(finalized.updatedUser.totalClaimedCelo.toFixed(4))
    },
    user: {
      id: finalized.updatedUser.id,
      wallet: finalized.updatedUser.wallet,
      dailyClaimStreak: finalized.updatedUser.dailyClaimStreak,
      totalClaimedCelo: Number(finalized.updatedUser.totalClaimedCelo.toFixed(4)),
      lastDailyClaimAt: finalized.updatedUser.lastDailyClaimAt?.toISOString() ?? null
    }
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
        FOR UPDATE
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
          claimDate,
          lastDailyClaimAt: rewardUser.lastDailyClaimAt?.toISOString() ?? null
        });
        throw new DailyRewardAlreadyClaimedError();
      }

      return { user: rewardUser, claim };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

export async function claimDailyCeloReward(input: { wallet: string }) {
  const wallet = normalizeWallet(input.wallet);
  const claimDate = getUtcClaimDate();
  const nextAvailableAt = getNextUtcMidnight();
  let user: DailyRewardUserRow | null = null;
  let claim: DailyRewardClaimRow | null = null;

  logger.info('[DAILY-REWARD] Claim requested', {
    wallet,
    claimDate,
    amountCelo: DAILY_REWARD_AMOUNT_CELO
  });

  const existingClaim = await findDailyRewardClaim(wallet, claimDate);
  if (existingClaim) {
    if (existingClaim.status === 'PAID') {
      throw new DailyRewardAlreadyClaimedError();
    }

    const recovered = await resumeExistingClaimIfPossible({
      claim: existingClaim,
      claimDate,
      nextAvailableAt
    });
    if (recovered) {
      return recovered;
    }
  }

  const reservation = await reserveDailyClaim(wallet, claimDate);
  user = reservation.user;
  claim = reservation.claim;
  let txHash: string | undefined;
  let claimFailurePersisted = false;

  try {
    const transferCost = await estimateTransferCost(wallet);
    if (transferCost.balance < transferCost.requiredBalance) {
      throw new DailyRewardPayoutError('Daily reward treasury balance is insufficient for payout and gas', 503, {
        step: 'balance_check',
        balanceWei: transferCost.balance.toString(),
        requiredBalanceWei: transferCost.requiredBalance.toString()
      });
    }

    logger.info('[DAILY-REWARD] Treasury balance verified', {
      userId: user.id,
      wallet,
      claimId: claim.id,
      claimDate,
      treasuryWallet: transferCost.treasuryWallet,
      amountCelo: DAILY_REWARD_AMOUNT_CELO,
      feeMode: transferCost.feeMode,
      balanceWei: transferCost.balance.toString(),
      requiredBalanceWei: transferCost.requiredBalance.toString(),
      estimatedGasCostWei: transferCost.estimatedGasCost.toString(),
      maxFeePerGasWei: transferCost.maxFeePerGas?.toString() ?? null,
      priorityFeePerGasWei: transferCost.priorityFeePerGas?.toString() ?? null
    });

    const tx = await transferCost.signer.sendTransaction({
      to: wallet,
      value: DAILY_REWARD_AMOUNT_WEI,
      gasLimit: transferCost.gasLimit,
      ...transferCost.txFeeOverrides
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
      await markClaimFailed(claim.id, new Error('Daily reward payout transaction was not confirmed successfully'), txHash, {
        confirmedOnchainFailure: true
      });
      claimFailurePersisted = true;
      throw new DailyRewardPayoutError('Daily reward payout transaction was not confirmed successfully', 502, {
        step: 'confirmation',
        claimId: claim.id,
        txHash,
        claimStateUpdate: 'persisted'
      });
    }
    if (!txHash) {
      throw new DailyRewardPayoutError('Daily reward payout transaction hash was missing after confirmation', 503, {
        step: 'confirmation',
        claimId: claim.id
      });
    }
    const confirmedTxHash = txHash;

    const finalized = await prisma.$transaction(
      async (txClient) => {
        const paidAt = new Date();
        const [updatedClaim] = await txClient.$queryRaw<DailyRewardClaimRow[]>`
          UPDATE "DailyRewardClaim"
          SET
            status = 'PAID'::"DailyRewardClaimStatus",
            "paidAt" = ${paidAt},
            "failureReason" = NULL,
            "updatedAt" = ${paidAt}
          WHERE
            id = ${claim.id}
            AND "txHash" = ${confirmedTxHash}
            AND status IN ('PROCESSING'::"DailyRewardClaimStatus", 'FAILED'::"DailyRewardClaimStatus")
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
          throw new DailyRewardPayoutError('Daily reward claim was no longer available to finalize', 503, {
            step: 'finalize',
            claimId: claim.id,
            txHash: confirmedTxHash
          });
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
          FOR UPDATE
          LIMIT 1
        `;
        if (!currentUser) {
          throw new DailyRewardPayoutError('Daily reward user record was not available during finalization', 503, {
            step: 'finalize_user_lookup',
            claimId: claim.id,
            txHash: confirmedTxHash
          });
        }
        const newStreak = wasYesterdayUtc(currentUser.lastDailyClaimAt, claimDate) ? currentUser.dailyClaimStreak + 1 : 1;

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
          throw new DailyRewardPayoutError('Daily reward user record was not updated', 503, {
            step: 'finalize_user_update',
            claimId: claim.id,
            txHash: confirmedTxHash
          });
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
              treasuryWallet: transferCost.treasuryWallet,
              feeMode: transferCost.feeMode,
              maxFeePerGasWei: transferCost.maxFeePerGas?.toString() ?? null,
              priorityFeePerGasWei: transferCost.priorityFeePerGas?.toString() ?? null
            }
          }
        });

        return { updatedClaim, updatedUser, paidAt };
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
      feeMode: transferCost.feeMode,
      dailyClaimStreak: finalized.updatedUser.dailyClaimStreak,
      totalClaimedCelo: finalized.updatedUser.totalClaimedCelo
    });

    return {
      success: true,
      message: 'Daily CELO reward claimed!',
      reward: {
        amountCelo: DAILY_REWARD_AMOUNT_CELO,
        txHash: finalized.updatedClaim.txHash!,
        claimedAt: finalized.paidAt.toISOString(),
        claimDate,
        nextAvailableAt: nextAvailableAt.toISOString(),
        dailyClaimStreak: finalized.updatedUser.dailyClaimStreak,
        totalClaimedCelo: Number(finalized.updatedUser.totalClaimedCelo.toFixed(4))
      },
      user: {
        id: finalized.updatedUser.id,
        wallet: finalized.updatedUser.wallet,
        dailyClaimStreak: finalized.updatedUser.dailyClaimStreak,
        totalClaimedCelo: Number(finalized.updatedUser.totalClaimedCelo.toFixed(4)),
        lastDailyClaimAt: finalized.updatedUser.lastDailyClaimAt?.toISOString() ?? null
      }
    };
  } catch (error) {
    const shouldSkipPersistence =
      error instanceof DailyRewardPayoutError && (error.statusCode === 202 || error.details?.claimStateUpdate === 'persisted');

    if (!shouldSkipPersistence && !claimFailurePersisted && claim) {
      await markClaimFailed(claim.id, error, txHash);
    }
    logger.error('[DAILY-REWARD] Claim payout failed', error, {
      userId: user?.id ?? null,
      wallet,
      claimId: claim?.id ?? null,
      claimDate,
      txHash: txHash ?? null,
      state: claimFailurePersisted
        ? 'persisted'
        : error instanceof DailyRewardPayoutError && error.statusCode === 202
          ? 'pending'
          : 'rolled_back',
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
