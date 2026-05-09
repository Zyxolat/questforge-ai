ALTER TYPE "QuestStatus" ADD VALUE IF NOT EXISTS 'FAILED';

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastQuestCompletedAt" TIMESTAMP;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastFailedAt" TIMESTAMP;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totalQuestsCompleted" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totalQuestsFailed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "streakDecayFactor" DOUBLE PRECISION NOT NULL DEFAULT 1.0;

ALTER TABLE "Quest" ADD COLUMN IF NOT EXISTS "maxRewardAmount" DOUBLE PRECISION;
ALTER TABLE "Quest" ADD COLUMN IF NOT EXISTS "xpReward" INTEGER NOT NULL DEFAULT 150;
ALTER TABLE "Quest" ADD COLUMN IF NOT EXISTS "minStakeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0.01;
ALTER TABLE "Quest" ADD COLUMN IF NOT EXISTS "maxStakeAmount" DOUBLE PRECISION NOT NULL DEFAULT 10.0;
ALTER TABLE "Quest" ADD COLUMN IF NOT EXISTS "stakeTxHash" TEXT;
ALTER TABLE "Quest" ADD COLUMN IF NOT EXISTS "proofTxHash" TEXT;
ALTER TABLE "Quest" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP;
ALTER TABLE "Quest" ADD COLUMN IF NOT EXISTS "failedAt" TIMESTAMP;

CREATE TABLE IF NOT EXISTS "QuestCooldown" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL UNIQUE,
  "cooldownUntil" TIMESTAMP NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuestCooldown_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "QuestCooldown_userId_cooldownUntil_idx" ON "QuestCooldown"("userId", "cooldownUntil");

CREATE TABLE IF NOT EXISTS "DailyActivity" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "date" TEXT NOT NULL,
  "questsAttempted" INTEGER NOT NULL DEFAULT 0,
  "questsCompleted" INTEGER NOT NULL DEFAULT 0,
  "xpEarned" INTEGER NOT NULL DEFAULT 0,
  "rewardsEarned" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DailyActivity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DailyActivity_userId_date_key" UNIQUE ("userId", "date")
);

CREATE INDEX IF NOT EXISTS "DailyActivity_userId_date_idx" ON "DailyActivity"("userId", "date");
CREATE INDEX IF NOT EXISTS "DailyActivity_date_idx" ON "DailyActivity"("date");

CREATE TABLE IF NOT EXISTS "ProofSubmission" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "questId" TEXT NOT NULL,
  "proofUri" TEXT NOT NULL,
  "proofHash" TEXT NOT NULL UNIQUE,
  "submittedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP,
  "verificationResult" TEXT,
  "verificationReason" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProofSubmission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProofSubmission_questId_fkey" FOREIGN KEY ("questId") REFERENCES "Quest"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ProofSubmission_userId_questId_idx" ON "ProofSubmission"("userId", "questId");
CREATE INDEX IF NOT EXISTS "ProofSubmission_proofHash_idx" ON "ProofSubmission"("proofHash");
CREATE INDEX IF NOT EXISTS "ProofSubmission_userId_submittedAt_idx" ON "ProofSubmission"("userId", "submittedAt");
CREATE INDEX IF NOT EXISTS "ProofSubmission_verificationResult_idx" ON "ProofSubmission"("verificationResult");

CREATE INDEX IF NOT EXISTS "Quest_creator_idx" ON "Quest"("creator");
CREATE INDEX IF NOT EXISTS "Quest_playerId_idx" ON "Quest"("playerId");
CREATE INDEX IF NOT EXISTS "Quest_status_idx" ON "Quest"("status");
CREATE INDEX IF NOT EXISTS "Quest_expiresAt_idx" ON "Quest"("expiresAt");
CREATE INDEX IF NOT EXISTS "Quest_chainQuestId_idx" ON "Quest"("chainQuestId");
