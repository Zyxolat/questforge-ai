DO $$
BEGIN
  CREATE TYPE "TreasuryPayoutStatus" AS ENUM ('RESERVED', 'LOCKED', 'RELEASED', 'PAID', 'REFUNDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "TreasuryPayout" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "questId" TEXT NOT NULL UNIQUE,
  "userId" TEXT,
  "chainQuestId" BIGINT NOT NULL UNIQUE,
  "playerWallet" TEXT,
  "rewardAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "stakeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "status" "TreasuryPayoutStatus" NOT NULL DEFAULT 'RESERVED',
  "reservationTx" TEXT,
  "releaseTx" TEXT,
  "payoutTx" TEXT,
  "refundTx" TEXT,
  "rewardReservedAt" TIMESTAMP,
  "rewardReleasedAt" TIMESTAMP,
  "rewardPaidAt" TIMESTAMP,
  "rewardRefundedAt" TIMESTAMP,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TreasuryPayout_questId_fkey" FOREIGN KEY ("questId") REFERENCES "Quest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TreasuryPayout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TreasuryPayout_userId_status_idx" ON "TreasuryPayout"("userId", "status");
CREATE INDEX IF NOT EXISTS "TreasuryPayout_playerWallet_status_idx" ON "TreasuryPayout"("playerWallet", "status");
CREATE INDEX IF NOT EXISTS "TreasuryPayout_chainQuestId_idx" ON "TreasuryPayout"("chainQuestId");
