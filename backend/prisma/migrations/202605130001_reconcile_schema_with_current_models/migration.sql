-- AlterTable
ALTER TABLE "DailyActivity"
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ProofSubmission"
ALTER COLUMN "submittedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "verifiedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Quest"
DROP COLUMN "missionTx",
ALTER COLUMN "completedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "failedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "QuestCooldown"
ALTER COLUMN "cooldownUntil" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TreasuryPayout"
ALTER COLUMN "rewardReservedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "rewardReleasedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "rewardPaidAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "rewardRefundedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "createdAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "updatedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User"
ALTER COLUMN "lastQuestCompletedAt" SET DATA TYPE TIMESTAMP(3),
ALTER COLUMN "lastFailedAt" SET DATA TYPE TIMESTAMP(3);

-- DropTable
DROP TABLE "indexer_state";

-- DropTable
DROP TABLE "processed_chain_events";

-- CreateTable
CREATE TABLE "IndexerState" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "lastBlockProcessed" BIGINT NOT NULL DEFAULT 0,
    "lastBlockTimestamp" TIMESTAMP(3),
    "isHealthy" BOOLEAN NOT NULL DEFAULT true,
    "lastErrorMessage" TEXT,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChainEvent" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "blockTimestamp" TIMESTAMP(3) NOT NULL,
    "transactionHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT,
    "contractAddress" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '0',
    "data" JSONB NOT NULL,
    "decodedData" JSONB,
    "chainQuestId" BIGINT,
    "playerWallet" TEXT,
    "creatorWallet" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "broadcastedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventQueue" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "chainEventId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "retries" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockHeader" (
    "id" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "parentHash" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "isFinalized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockHeader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RpcEndpoint" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "healthy" BOOLEAN NOT NULL DEFAULT true,
    "healthScore" INTEGER NOT NULL DEFAULT 100,
    "lastCheckedAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "totalRequests" BIGINT NOT NULL DEFAULT 0,
    "failedRequests" BIGINT NOT NULL DEFAULT 0,
    "avgLatencyMs" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RpcEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueMetrics" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queueDepth" INTEGER NOT NULL,
    "processingRate" DOUBLE PRECISION NOT NULL,
    "errorRate" DOUBLE PRECISION NOT NULL,
    "avgLatencyMs" DOUBLE PRECISION NOT NULL,
    "activeWorkers" INTEGER NOT NULL,
    "rpcLatencyMs" DOUBLE PRECISION NOT NULL,
    "websocketConnections" INTEGER NOT NULL,

    CONSTRAINT "QueueMetrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IndexerState_key_key" ON "IndexerState"("key");

-- CreateIndex
CREATE INDEX "IndexerState_key_idx" ON "IndexerState"("key");

-- CreateIndex
CREATE INDEX "IndexerState_lastBlockProcessed_idx" ON "IndexerState"("lastBlockProcessed");

-- CreateIndex
CREATE UNIQUE INDEX "ChainEvent_eventKey_key" ON "ChainEvent"("eventKey");

-- CreateIndex
CREATE INDEX "ChainEvent_eventName_idx" ON "ChainEvent"("eventName");

-- CreateIndex
CREATE INDEX "ChainEvent_blockNumber_idx" ON "ChainEvent"("blockNumber");

-- CreateIndex
CREATE INDEX "ChainEvent_blockHash_idx" ON "ChainEvent"("blockHash");

-- CreateIndex
CREATE INDEX "ChainEvent_transactionHash_idx" ON "ChainEvent"("transactionHash");

-- CreateIndex
CREATE INDEX "ChainEvent_playerWallet_idx" ON "ChainEvent"("playerWallet");

-- CreateIndex
CREATE INDEX "ChainEvent_creatorWallet_idx" ON "ChainEvent"("creatorWallet");

-- CreateIndex
CREATE INDEX "ChainEvent_processed_idx" ON "ChainEvent"("processed");

-- CreateIndex
CREATE INDEX "ChainEvent_processedAt_idx" ON "ChainEvent"("processedAt");

-- CreateIndex
CREATE INDEX "ChainEvent_blockTimestamp_idx" ON "ChainEvent"("blockTimestamp");

-- CreateIndex
CREATE INDEX "ChainEvent_invalidatedAt_idx" ON "ChainEvent"("invalidatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChainEvent_transactionHash_logIndex_key" ON "ChainEvent"("transactionHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "EventQueue_jobId_key" ON "EventQueue"("jobId");

-- CreateIndex
CREATE INDEX "EventQueue_status_idx" ON "EventQueue"("status");

-- CreateIndex
CREATE INDEX "EventQueue_chainEventId_idx" ON "EventQueue"("chainEventId");

-- CreateIndex
CREATE INDEX "EventQueue_createdAt_idx" ON "EventQueue"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BlockHeader_blockNumber_key" ON "BlockHeader"("blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "BlockHeader_blockHash_key" ON "BlockHeader"("blockHash");

-- CreateIndex
CREATE INDEX "BlockHeader_blockNumber_idx" ON "BlockHeader"("blockNumber");

-- CreateIndex
CREATE INDEX "BlockHeader_blockHash_idx" ON "BlockHeader"("blockHash");

-- CreateIndex
CREATE UNIQUE INDEX "RpcEndpoint_url_key" ON "RpcEndpoint"("url");

-- CreateIndex
CREATE INDEX "RpcEndpoint_healthy_idx" ON "RpcEndpoint"("healthy");

-- CreateIndex
CREATE INDEX "RpcEndpoint_healthScore_idx" ON "RpcEndpoint"("healthScore");

-- CreateIndex
CREATE INDEX "RpcEndpoint_priority_idx" ON "RpcEndpoint"("priority");

-- CreateIndex
CREATE INDEX "QueueMetrics_timestamp_idx" ON "QueueMetrics"("timestamp");
