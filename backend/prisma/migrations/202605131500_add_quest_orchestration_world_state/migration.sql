ALTER TABLE "Quest"
ADD COLUMN "orchestrationId" TEXT,
ADD COLUMN "worldStateVersion" INTEGER DEFAULT 1;

CREATE UNIQUE INDEX "Quest_orchestrationId_key" ON "Quest"("orchestrationId");
CREATE INDEX "Quest_worldStateVersion_idx" ON "Quest"("worldStateVersion");

CREATE TABLE "WorldStateSnapshot" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshotType" TEXT NOT NULL DEFAULT 'global',
    "trigger" TEXT NOT NULL DEFAULT 'startup',
    "seasonKey" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "sourceEventIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "changedKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorldStateSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorldStateSnapshot_version_key" ON "WorldStateSnapshot"("version");
CREATE INDEX "WorldStateSnapshot_isActive_version_idx" ON "WorldStateSnapshot"("isActive", "version");
CREATE INDEX "WorldStateSnapshot_seasonKey_idx" ON "WorldStateSnapshot"("seasonKey");
CREATE INDEX "WorldStateSnapshot_stateHash_idx" ON "WorldStateSnapshot"("stateHash");
