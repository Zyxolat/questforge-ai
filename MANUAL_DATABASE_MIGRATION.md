# Manual Database Migration Guide

If automated Prisma migration fails, use this SQL to manually create the production hardening tables.

## Prerequisites
- PostgreSQL database connected
- `questforge` database exists
- All existing tables created (User, Quest, etc.)

## SQL Migration Script

```sql
-- Create BlockHeader table for reorg detection
CREATE TABLE IF NOT EXISTS "BlockHeader" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "parentHash" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "isFinalized" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BlockHeader_blockNumber_key" UNIQUE("blockNumber")
);

CREATE INDEX "BlockHeader_blockNumber_idx" ON "BlockHeader"("blockNumber");
CREATE INDEX "BlockHeader_blockHash_idx" ON "BlockHeader"("blockHash");

-- Create RpcEndpoint table for failover health tracking
CREATE TABLE IF NOT EXISTS "RpcEndpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "url" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 1,
    "healthScore" FLOAT NOT NULL DEFAULT 100.0,
    "latency" INTEGER DEFAULT 0,
    "totalRequests" INTEGER NOT NULL DEFAULT 0,
    "failedRequests" INTEGER NOT NULL DEFAULT 0,
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RpcEndpoint_url_key" UNIQUE("url")
);

CREATE INDEX "RpcEndpoint_healthScore_idx" ON "RpcEndpoint"("healthScore");

-- Create QueueMetrics table for monitoring
CREATE TABLE IF NOT EXISTS "QueueMetrics" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queueDepth" INTEGER NOT NULL DEFAULT 0,
    "waiting" INTEGER NOT NULL DEFAULT 0,
    "active" INTEGER NOT NULL DEFAULT 0,
    "delayed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "completed" INTEGER NOT NULL DEFAULT 0,
    "processingRate" FLOAT NOT NULL DEFAULT 0.0,
    "errorRate" FLOAT NOT NULL DEFAULT 0.0,
    "averageLatency" FLOAT NOT NULL DEFAULT 0.0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "QueueMetrics_timestamp_idx" ON "QueueMetrics"("timestamp" DESC);

-- Update ChainEvent table with new fields
ALTER TABLE "ChainEvent" 
ADD COLUMN IF NOT EXISTS "blockHash" TEXT,
ADD COLUMN IF NOT EXISTS "invalidatedAt" TIMESTAMP(3);

-- Add indexes for better query performance
CREATE INDEX IF NOT EXISTS "ChainEvent_blockHash_idx" ON "ChainEvent"("blockHash");
CREATE INDEX IF NOT EXISTS "ChainEvent_invalidatedAt_idx" ON "ChainEvent"("invalidatedAt");

-- Add unique constraint for idempotency (if not already present)
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE tablename = 'ChainEvent' 
        AND indexname = 'ChainEvent_transactionHash_logIndex_key'
    ) THEN
        CREATE UNIQUE INDEX "ChainEvent_transactionHash_logIndex_key" 
        ON "ChainEvent"("transactionHash", "logIndex");
    END IF;
END $$;

-- Verify migration
SELECT COUNT(*) as "BlockHeaders" FROM "BlockHeader";
SELECT COUNT(*) as "RpcEndpoints" FROM "RpcEndpoint";
SELECT COUNT(*) as "QueueMetrics" FROM "QueueMetrics";
SELECT COUNT(*) as "ChainEvents" FROM "ChainEvent" WHERE "blockHash" IS NOT NULL;

-- Expected output:
-- BlockHeaders  | 0
-- RpcEndpoints  | 0
-- QueueMetrics  | 0
-- ChainEvents   | 0 (initially, populated during operation)
```

## Execution Steps

### Option 1: Using psql CLI
```bash
cd backend
psql -U questforge_user -h localhost -d questforge < migration.sql
```

### Option 2: Direct SQL Execution
```bash
psql -U questforge_user -h localhost -d questforge
```

Then paste the SQL script above into the interactive psql prompt.

### Option 3: Using Prisma CLI (if shadow database issues are resolved)
```bash
npm run prisma:migrate -- --name production_hardening
```

## Verification

After migration, verify tables were created:

```sql
-- List all new tables
\dt "BlockHeader" "RpcEndpoint" "QueueMetrics"

-- Check ChainEvent structure
\d "ChainEvent"

-- Verify indexes
\di "ChainEvent_blockHash_idx" "ChainEvent_invalidatedAt_idx"
```

Expected output:
```
                List of relations
 Schema |       Name       | Type  |     Owner
--------+-----------------+-------+----------------
 public | BlockHeader     | table | questforge_user
 public | RpcEndpoint     | table | questforge_user
 public | QueueMetrics    | table | questforge_user
(3 rows)
```

## Rollback (if needed)

```sql
-- Drop new tables and columns
DROP TABLE IF EXISTS "BlockHeader" CASCADE;
DROP TABLE IF EXISTS "RpcEndpoint" CASCADE;
DROP TABLE IF EXISTS "QueueMetrics" CASCADE;

ALTER TABLE "ChainEvent" 
DROP COLUMN IF EXISTS "blockHash",
DROP COLUMN IF EXISTS "invalidatedAt";

DROP INDEX IF EXISTS "ChainEvent_blockHash_idx";
DROP INDEX IF EXISTS "ChainEvent_invalidatedAt_idx";
```

## Notes

- Migration is **non-destructive** - only adds new tables and columns
- Existing data in `ChainEvent` remains unchanged
- Indexes improve query performance but can be created/dropped safely
- All constraints are additive (no existing constraints removed)
- Safe to run multiple times (uses `IF NOT EXISTS`)

