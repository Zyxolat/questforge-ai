CREATE TABLE "MemoryLedgerEntry" (
    "id" TEXT NOT NULL,
    "replayKey" TEXT NOT NULL,
    "memoryType" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "importanceScore" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "embedding" DOUBLE PRECISION[],
    "metadata" JSONB NOT NULL,
    "seasonKey" TEXT,
    "eventTimestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,
    "npcId" TEXT,
    "agentId" TEXT,
    "questId" TEXT,
    CONSTRAINT "MemoryLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MemoryLedgerEntry_replayKey_key" ON "MemoryLedgerEntry"("replayKey");
CREATE INDEX "MemoryLedgerEntry_userId_eventTimestamp_idx" ON "MemoryLedgerEntry"("userId", "eventTimestamp");
CREATE INDEX "MemoryLedgerEntry_npcId_eventTimestamp_idx" ON "MemoryLedgerEntry"("npcId", "eventTimestamp");
CREATE INDEX "MemoryLedgerEntry_agentId_eventTimestamp_idx" ON "MemoryLedgerEntry"("agentId", "eventTimestamp");
CREATE INDEX "MemoryLedgerEntry_questId_idx" ON "MemoryLedgerEntry"("questId");
CREATE INDEX "MemoryLedgerEntry_memoryType_importanceScore_idx" ON "MemoryLedgerEntry"("memoryType", "importanceScore");

ALTER TABLE "MemoryLedgerEntry" ADD CONSTRAINT "MemoryLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MemoryLedgerEntry" ADD CONSTRAINT "MemoryLedgerEntry_npcId_fkey" FOREIGN KEY ("npcId") REFERENCES "NPC"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MemoryLedgerEntry" ADD CONSTRAINT "MemoryLedgerEntry_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MemoryLedgerEntry" ADD CONSTRAINT "MemoryLedgerEntry_questId_fkey" FOREIGN KEY ("questId") REFERENCES "Quest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PlayerNarrativeState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentArc" TEXT NOT NULL,
    "narrativeVersion" INTEGER NOT NULL DEFAULT 1,
    "reputationTier" TEXT NOT NULL DEFAULT 'initiate',
    "lastMemoryAt" TIMESTAMP(3),
    "factionStandingSummary" JSONB NOT NULL,
    "npcTrustSummary" JSONB NOT NULL,
    "stateData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlayerNarrativeState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlayerNarrativeState_userId_key" ON "PlayerNarrativeState"("userId");
CREATE INDEX "PlayerNarrativeState_reputationTier_idx" ON "PlayerNarrativeState"("reputationTier");
CREATE INDEX "PlayerNarrativeState_narrativeVersion_idx" ON "PlayerNarrativeState"("narrativeVersion");
ALTER TABLE "PlayerNarrativeState" ADD CONSTRAINT "PlayerNarrativeState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FactionStanding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "factionId" TEXT NOT NULL,
    "factionName" TEXT NOT NULL,
    "standingScore" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "influenceRank" TEXT NOT NULL DEFAULT 'unknown',
    "allianceStatus" TEXT NOT NULL DEFAULT 'neutral',
    "narrativeFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL,
    "lastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FactionStanding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FactionStanding_userId_factionId_key" ON "FactionStanding"("userId", "factionId");
CREATE INDEX "FactionStanding_factionId_standingScore_idx" ON "FactionStanding"("factionId", "standingScore");
CREATE INDEX "FactionStanding_userId_standingScore_idx" ON "FactionStanding"("userId", "standingScore");
ALTER TABLE "FactionStanding" ADD CONSTRAINT "FactionStanding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProjectionCursor" (
    "id" TEXT NOT NULL,
    "projectorKey" TEXT NOT NULL,
    "projectionVersion" INTEGER NOT NULL DEFAULT 1,
    "lastEventKey" TEXT,
    "lastProcessedBlock" BIGINT,
    "lastProcessedAt" TIMESTAMP(3),
    "stateHash" TEXT,
    "metrics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectionCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectionCursor_projectorKey_key" ON "ProjectionCursor"("projectorKey");

CREATE TABLE "ProjectionDeadLetter" (
    "id" TEXT NOT NULL,
    "projectorKey" TEXT NOT NULL,
    "chainEventId" TEXT,
    "eventKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "errorMessage" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProjectionDeadLetter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectionDeadLetter_projectorKey_eventKey_key" ON "ProjectionDeadLetter"("projectorKey", "eventKey");
CREATE INDEX "ProjectionDeadLetter_projectorKey_resolvedAt_idx" ON "ProjectionDeadLetter"("projectorKey", "resolvedAt");

CREATE TABLE "RealtimeFeedEvent" (
    "id" SERIAL NOT NULL,
    "replayKey" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RealtimeFeedEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RealtimeFeedEvent_replayKey_key" ON "RealtimeFeedEvent"("replayKey");
CREATE INDEX "RealtimeFeedEvent_scopeType_scopeKey_id_idx" ON "RealtimeFeedEvent"("scopeType", "scopeKey", "id");
CREATE INDEX "RealtimeFeedEvent_eventName_id_idx" ON "RealtimeFeedEvent"("eventName", "id");
