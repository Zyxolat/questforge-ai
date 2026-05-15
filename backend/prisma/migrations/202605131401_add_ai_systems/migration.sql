-- Add AI NPC System
CREATE TABLE "NPC" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "personality" JSONB NOT NULL,
    "currentLocation" TEXT NOT NULL DEFAULT 'tavern',
    "reputation" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "lastInteractionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "NPCMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "npcId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "memory" TEXT NOT NULL,
    "embedding" REAL[],
    "importanceScore" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "interactionCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NPCMemory_npcId_fkey" FOREIGN KEY ("npcId") REFERENCES "NPC" ("id") ON DELETE CASCADE
);

CREATE INDEX "NPC_type_idx" ON "NPC"("type");
CREATE INDEX "NPC_reputation_idx" ON "NPC"("reputation");
CREATE INDEX "NPCMemory_npcId_wallet_idx" ON "NPCMemory"("npcId", "wallet");
CREATE INDEX "NPCMemory_importanceScore_idx" ON "NPCMemory"("importanceScore");

-- Add AI Agent Identity System (ERC-8004 Compatible)
CREATE TABLE "AgentIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "wallet" TEXT NOT NULL UNIQUE,
    "agentName" TEXT NOT NULL,
    "agentDescriptor" TEXT NOT NULL,
    "personalityVector" REAL[],
    "memoryGraph" JSONB NOT NULL,
    "reputationScore" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "worldStateVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "memoryType" TEXT NOT NULL,
    "memoryData" JSONB NOT NULL,
    "embedding" REAL[],
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentMemory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity" ("id") ON DELETE CASCADE
);

CREATE INDEX "AgentMemory_agentId_memoryType_idx" ON "AgentMemory"("agentId", "memoryType");
CREATE INDEX "AgentMemory_questId_idx" ON "AgentMemory"("questId");

-- Add Clan/Guild System
CREATE TABLE "Clan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL UNIQUE,
    "description" TEXT,
    "founderId" TEXT NOT NULL,
    "questsCompleted" INTEGER NOT NULL DEFAULT 0,
    "totalRewards" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "treasuryBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reputation" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Clan_founderId_fkey" FOREIGN KEY ("founderId") REFERENCES "User" ("id") ON DELETE CASCADE
);

CREATE TABLE "ClanQuest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clanId" TEXT NOT NULL,
    "questId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "rewardDistribution" JSONB NOT NULL,
    "participantCount" INTEGER NOT NULL DEFAULT 1,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClanQuest_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "Clan" ("id") ON DELETE CASCADE,
    CONSTRAINT "ClanQuest_questId_fkey" FOREIGN KEY ("questId") REFERENCES "Quest" ("id") ON DELETE CASCADE
);

CREATE TABLE "ClanTreasury" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clanId" TEXT NOT NULL UNIQUE,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClanTreasury_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "Clan" ("id") ON DELETE CASCADE
);

CREATE TABLE "ClanTreasuryTx" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "treasuryId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "userId" TEXT,
    "txHash" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClanTreasuryTx_treasuryId_fkey" FOREIGN KEY ("treasuryId") REFERENCES "ClanTreasury" ("id") ON DELETE CASCADE,
    CONSTRAINT "ClanTreasuryTx_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id")
);

CREATE INDEX "Clan_founderId_idx" ON "Clan"("founderId");
CREATE INDEX "Clan_reputation_idx" ON "Clan"("reputation");
CREATE INDEX "ClanQuest_clanId_status_idx" ON "ClanQuest"("clanId", "status");
CREATE INDEX "ClanQuest_questId_idx" ON "ClanQuest"("questId");
CREATE INDEX "ClanTreasuryTx_treasuryId_type_idx" ON "ClanTreasuryTx"("treasuryId", "type");
CREATE INDEX "ClanTreasuryTx_userId_idx" ON "ClanTreasuryTx"("userId");

-- Add World State & Dynamic Events
CREATE TABLE "WorldEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "reward" DOUBLE PRECISION NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "difficulty" INTEGER NOT NULL DEFAULT 3,
    "affectsAllQuests" BOOLEAN NOT NULL DEFAULT false,
    "eventData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "DailyQuest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL UNIQUE,
    "questTemplate" TEXT NOT NULL,
    "difficulty" INTEGER NOT NULL DEFAULT 3,
    "specialEvent" TEXT,
    "completionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "WorldEvent_isActive_idx" ON "WorldEvent"("isActive");
CREATE INDEX "WorldEvent_startTime_endTime_idx" ON "WorldEvent"("startTime", "endTime");
CREATE INDEX "DailyQuest_date_idx" ON "DailyQuest"("date");

-- Update User model to add AI and Clan relationships
ALTER TABLE "User" ADD COLUMN "agentId" TEXT;
ALTER TABLE "User" ADD COLUMN "clanId" TEXT;
ALTER TABLE "User" ADD COLUMN "joinedClanAt" TIMESTAMP(3);

-- Update NPCConversation to link to NPC
ALTER TABLE "NPCConversation" ADD COLUMN "npcId" TEXT;
ALTER TABLE "NPCConversation" ADD CONSTRAINT "NPCConversation_npcId_fkey" FOREIGN KEY ("npcId") REFERENCES "NPC" ("id") ON DELETE CASCADE;
ALTER TABLE "NPCConversation" ADD CONSTRAINT "NPCConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE;
ALTER TABLE "NPCConversation" DROP COLUMN "npcType" IF EXISTS;
ALTER TABLE "NPCConversation" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Update Quest model to support NPCs, clans, and multi-TX
ALTER TABLE "Quest" ADD COLUMN "npcGiverId" TEXT;
ALTER TABLE "Quest" ADD COLUMN "transactionCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Quest" ADD COLUMN "requiredTxTypes" JSONB;
ALTER TABLE "Quest" ADD COLUMN "isEventQuest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Quest" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Quest" ADD CONSTRAINT "Quest_npcGiverId_fkey" FOREIGN KEY ("npcGiverId") REFERENCES "NPC" ("id") ON DELETE SET NULL;

-- Add foreign keys for User
ALTER TABLE "User" ADD CONSTRAINT "User_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity" ("id") ON DELETE SET NULL;
ALTER TABLE "User" ADD CONSTRAINT "User_clanId_fkey" FOREIGN KEY ("clanId") REFERENCES "Clan" ("id") ON DELETE SET NULL;

-- Add indexes for new fields
CREATE INDEX "User_agentId_idx" ON "User"("agentId");
CREATE INDEX "User_clanId_idx" ON "User"("clanId");
CREATE INDEX "Quest_npcGiverId_idx" ON "Quest"("npcGiverId");
CREATE INDEX "NPCConversation_npcId_userId_idx" ON "NPCConversation"("npcId", "userId");
