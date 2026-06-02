-- Persist daily CELO reward claim state and user-level reward totals.

ALTER TABLE "User"
ADD COLUMN "lastDailyClaimAt" TIMESTAMP(3),
ADD COLUMN "dailyClaimStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "totalClaimedCelo" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TYPE "DailyRewardClaimStatus" AS ENUM ('PROCESSING', 'PAID', 'FAILED');

CREATE TABLE "DailyRewardClaim" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "wallet" TEXT NOT NULL,
  "claimDate" TEXT NOT NULL,
  "amountCelo" DOUBLE PRECISION NOT NULL,
  "txHash" TEXT,
  "status" "DailyRewardClaimStatus" NOT NULL DEFAULT 'PROCESSING',
  "processingStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "DailyRewardClaim_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DailyRewardClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DailyRewardClaim_userId_claimDate_key" ON "DailyRewardClaim"("userId", "claimDate");
CREATE UNIQUE INDEX "DailyRewardClaim_txHash_key" ON "DailyRewardClaim"("txHash");
CREATE INDEX "DailyRewardClaim_wallet_claimDate_idx" ON "DailyRewardClaim"("wallet", "claimDate");
CREATE INDEX "DailyRewardClaim_status_claimDate_idx" ON "DailyRewardClaim"("status", "claimDate");
