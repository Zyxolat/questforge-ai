/*
  Warnings:

  - The values [ACTIVE,SUBMITTED,VERIFIED,CANCELLED,FAILED,STAKED,STARTED] on the enum `QuestStatus` will be normalized. If these variants are still used in the database, this migration will proactively convert them.
  - You are about to drop the column `maxStakeAmount` on the `Quest` table. All the data in the column will be lost.
  - You are about to drop the column `minStakeAmount` on the `Quest` table. All the data in the column will be lost.
  - Made the column `npcId` on table `NPCConversation` required. This step will fail if there are existing NULL or orphaned values in that column.

*/

-- AlterEnum
BEGIN;
-- Normalize legacy Quest statuses before enum conversion.
UPDATE "Quest"
SET "status" = CASE
  WHEN "status" = 'ACTIVE' THEN 'ACCEPTED'
  WHEN "status" = 'STARTED' THEN 'ACCEPTED'
  WHEN "status" = 'STAKED' THEN 'ACCEPTED'
  WHEN "status" = 'SUBMITTED' THEN 'CLAIMABLE'
  WHEN "status" = 'VERIFIED' THEN 'CLAIMABLE'
  WHEN "status" = 'FAILED' THEN 'ACCEPTED'
  WHEN "status" = 'CANCELLED' THEN 'AVAILABLE'
  ELSE "status"
END
WHERE "status" IN ('ACTIVE','STARTED','STAKED','SUBMITTED','VERIFIED','FAILED','CANCELLED');

-- Repair NPCConversation references before NOT NULL / FK enforcement.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "NPCConversation" WHERE "npcId" IS NULL OR NOT EXISTS (SELECT 1 FROM "NPC" WHERE "NPC"."id" = "NPCConversation"."npcId")) THEN
    INSERT INTO "NPC" ("id", "type", "name", "personality", "currentLocation", "reputation", "createdAt", "updatedAt")
    VALUES ('00000000-0000-0000-0000-000000000000', 'quest_giver', 'Unknown NPC', '{}', 'tavern', 0.0, now(), now())
    ON CONFLICT ("id") DO NOTHING;

    UPDATE "NPCConversation"
    SET "npcId" = '00000000-0000-0000-0000-000000000000'
    WHERE "npcId" IS NULL
       OR NOT EXISTS (SELECT 1 FROM "NPC" WHERE "NPC"."id" = "NPCConversation"."npcId");
  END IF;
END;
$$;

CREATE TYPE "QuestStatus_new" AS ENUM ('AVAILABLE', 'ACCEPTED', 'COMPLETED', 'CLAIMABLE', 'REWARDED');
ALTER TABLE "Quest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Quest" ALTER COLUMN "status" TYPE "QuestStatus_new" USING ("status"::text::"QuestStatus_new");
ALTER TYPE "QuestStatus" RENAME TO "QuestStatus_old";
ALTER TYPE "QuestStatus_new" RENAME TO "QuestStatus";
DROP TYPE "QuestStatus_old";
ALTER TABLE "Quest" ALTER COLUMN "status" SET DEFAULT 'AVAILABLE';
COMMIT;

-- DropForeignKey
ALTER TABLE "AgentMemory" DROP CONSTRAINT "AgentMemory_agentId_fkey";

-- DropForeignKey
ALTER TABLE "Clan" DROP CONSTRAINT "Clan_founderId_fkey";

-- DropForeignKey
ALTER TABLE "ClanQuest" DROP CONSTRAINT "ClanQuest_clanId_fkey";

-- DropForeignKey
ALTER TABLE "ClanQuest" DROP CONSTRAINT "ClanQuest_questId_fkey";

-- DropForeignKey
ALTER TABLE "ClanTreasury" DROP CONSTRAINT "ClanTreasury_clanId_fkey";

-- DropForeignKey
ALTER TABLE "ClanTreasuryTx" DROP CONSTRAINT "ClanTreasuryTx_treasuryId_fkey";

-- DropForeignKey
ALTER TABLE "ClanTreasuryTx" DROP CONSTRAINT "ClanTreasuryTx_userId_fkey";

-- DropForeignKey
ALTER TABLE "NPCConversation" DROP CONSTRAINT "NPCConversation_npcId_fkey";

-- DropForeignKey
ALTER TABLE "NPCConversation" DROP CONSTRAINT "NPCConversation_userId_fkey";

-- DropForeignKey
ALTER TABLE "NPCMemory" DROP CONSTRAINT "NPCMemory_npcId_fkey";

-- DropForeignKey
ALTER TABLE "Quest" DROP CONSTRAINT "Quest_npcGiverId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_agentId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_clanId_fkey";

-- DropIndex
DROP INDEX "NPCConversation_npcId_userId_idx";

-- DropIndex
DROP INDEX "User_agentId_idx";

-- DropIndex
DROP INDEX "User_clanId_idx";

-- AlterTable
ALTER TABLE "AgentIdentity" ALTER COLUMN "personalityVector" SET DATA TYPE DOUBLE PRECISION[],
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "AgentMemory" ALTER COLUMN "embedding" SET DATA TYPE DOUBLE PRECISION[];

-- AlterTable
ALTER TABLE "Clan" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ClanQuest" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ClanTreasury" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DailyQuest" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "DailyRewardClaim" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "FactionStanding" ALTER COLUMN "narrativeFlags" DROP DEFAULT;

-- AlterTable
ALTER TABLE "NPC" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "NPCConversation" ALTER COLUMN "npcId" SET NOT NULL,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "NPCMemory" ALTER COLUMN "embedding" SET DATA TYPE DOUBLE PRECISION[],
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Quest" DROP COLUMN "maxStakeAmount",
DROP COLUMN "minStakeAmount",
ADD COLUMN     "durationSeconds" INTEGER,
ADD COLUMN     "metadataUri" TEXT,
ALTER COLUMN "stakeAmount" SET DEFAULT 0,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorldEvent" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "WorldStateSnapshot" ALTER COLUMN "sourceEventIds" DROP DEFAULT,
ALTER COLUMN "changedKeys" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "NPCConversation_userId_npcId_idx" ON "NPCConversation"("userId", "npcId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "Clan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quest" ADD CONSTRAINT "Quest_npcGiverId_fkey" FOREIGN KEY ("npcGiverId") REFERENCES "NPC"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NPCConversation" ADD CONSTRAINT "NPCConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NPCConversation" ADD CONSTRAINT "NPCConversation_npcId_fkey" FOREIGN KEY ("npcId") REFERENCES "NPC"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NPCMemory" ADD CONSTRAINT "NPCMemory_npcId_fkey" FOREIGN KEY ("npcId") REFERENCES "NPC"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Clan" ADD CONSTRAINT "Clan_founderId_fkey" FOREIGN KEY ("founderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClanQuest" ADD CONSTRAINT "ClanQuest_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "Clan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClanQuest" ADD CONSTRAINT "ClanQuest_questId_fkey" FOREIGN KEY ("questId") REFERENCES "Quest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClanTreasury" ADD CONSTRAINT "ClanTreasury_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "Clan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClanTreasuryTx" ADD CONSTRAINT "ClanTreasuryTx_treasuryId_fkey" FOREIGN KEY ("treasuryId") REFERENCES "ClanTreasury"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClanTreasuryTx" ADD CONSTRAINT "ClanTreasuryTx_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
