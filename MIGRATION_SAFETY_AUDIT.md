# Migration Safety Audit

## 1. Root cause analysis

The failing migration is `20260608085841_init`.

Primary failure risks:

- The migration rewrites the `QuestStatus` enum to only include `AVAILABLE`, `ACCEPTED`, `COMPLETED`, `CLAIMABLE`, and `REWARDED`.
- Any existing rows with legacy enum values such as `ACTIVE`, `SUBMITTED`, `VERIFIED`, `CANCELLED`, or `FAILED` will cause the `ALTER COLUMN ... TYPE` step to fail.
- The migration also makes `NPCConversation.npcId` NOT NULL. If any existing `NPCConversation` rows contain `NULL` for `npcId`, the migration will fail.

Secondary risks:

- The migration drops legacy columns `Quest.maxStakeAmount` and `Quest.minStakeAmount`, which is data-destructive.
- There are many foreign-key and index modifications across AI/quest-related tables, increasing the chance of schema mismatch if production has drifted.

## 2. Failing migration analysis

### Tables affected

- `Quest`
- `AgentMemory`
- `Clan`
- `ClanQuest`
- `ClanTreasury`
- `ClanTreasuryTx`
- `NPCConversation`
- `NPCMemory`
- `User`
- `AgentIdentity`
- `NPC`
- `WorldEvent`
- `WorldStateSnapshot`

### Columns added

- `Quest.durationSeconds` (INTEGER)
- `Quest.metadataUri` (TEXT)

### Columns removed

- `Quest.maxStakeAmount`
- `Quest.minStakeAmount`

### Enums changed

- `QuestStatus` is recreated as an enum with values:
  - `AVAILABLE`
  - `ACCEPTED`
  - `COMPLETED`
  - `CLAIMABLE`
  - `REWARDED`

### Constraints changed

- Drop and re-add foreign keys for:
  - `AgentMemory.agentId`
  - `Clan.founderId`
  - `ClanQuest.clanId`
  - `ClanQuest.questId`
  - `ClanTreasury.clanId`
  - `ClanTreasuryTx.treasuryId`
  - `ClanTreasuryTx.userId`
  - `NPCConversation.npcId`
  - `NPCConversation.userId`
  - `NPCMemory.npcId`
  - `Quest.npcGiverId`
  - `User.agentId`
  - `User.clanId`
- Recreate index:
  - `NPCConversation_userId_npcId_idx`

### Data-destructive operations

- Dropping `Quest.maxStakeAmount` permanently removes stored stake max values.
- Dropping `Quest.minStakeAmount` permanently removes stored stake min values.
- Changing `QuestStatus` by rewriting the enum can lose status semantics if old statuses are not preserved or converted.

### NOT NULL conversions

- `NPCConversation.npcId` is changed to `NOT NULL`.

### Enum value removals

From migration warnings, removed `QuestStatus` values include:

- `ACTIVE`
- `SUBMITTED`
- `VERIFIED`
- `CANCELLED`
- `FAILED`

Additional legacy statuses referenced in repo history and documentation, which may also exist in production data, include:

- `STAKED`
- `STARTED`

### Highlighted failure points

- `ALTER TABLE "Quest" ALTER COLUMN "status" TYPE "QuestStatus_new" USING ("status"::text::"QuestStatus_new")` will fail if any row contains a removed status.
- `ALTER TABLE "NPCConversation" ALTER COLUMN "npcId" SET NOT NULL` will fail if any row has `npcId IS NULL`.
- `ALTER TABLE "Quest" DROP COLUMN "maxStakeAmount"` and `DROP COLUMN "minStakeAmount"` are destructive but will not fail unless the columns do not exist.

## 3. Data compatibility analysis

### Old vs current `QuestStatus`

- Old statuses removed by the migration: `ACTIVE`, `SUBMITTED`, `VERIFIED`, `CANCELLED`, `FAILED`
- Current schema values: `AVAILABLE`, `ACCEPTED`, `COMPLETED`, `CLAIMABLE`, `REWARDED`

### Potential production data failures

If production contains any of the removed statuses, the migration will fail immediately during enum conversion.

### SQL queries to identify affected rows

```sql
SELECT status, COUNT(*)
FROM "Quest"
GROUP BY status;
```

```sql
SELECT status, COUNT(*)
FROM "Quest"
WHERE status IN ('ACTIVE','SUBMITTED','VERIFIED','CANCELLED','FAILED','STAKED','STARTED')
GROUP BY status;
```

### Recommended status diagnostics

- Count rows for each legacy status.
- Evaluate whether legacy rows are active or historical.

## 4. Quest status mapping

Required current statuses:

- `AVAILABLE`
- `ACCEPTED`
- `COMPLETED`
- `CLAIMABLE`
- `REWARDED`

Legacy-to-current mapping proposals based on documented business flow and current code behavior:

| Legacy status | Mapped status             | Rationale                                                                                                                                                                    |
| ------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIVE`      | `ACCEPTED`                | Old active quests are likely equivalent to accepted quests in current flow.                                                                                                  |
| `SUBMITTED`   | `CLAIMABLE`               | Submitted proofs historically expected verification; current flow has a separate claimable state for completed verified quests.                                              |
| `VERIFIED`    | `CLAIMABLE`               | Verified quests appear to become claimable for reward settlement.                                                                                                            |
| `FAILED`      | `ACCEPTED`                | Failed quests likely should revert to accepted-like state if they are still recoverable, or be archived separately; current schema has no explicit failed state.             |
| `CANCELLED`   | `AVAILABLE` or `ACCEPTED` | Cancelled quests may need manual review; safest mapping is `AVAILABLE` if they should re-enter the pool, else `ACCEPTED` if still assigned. This depends on business policy. |
| `STAKED`      | `ACCEPTED`                | If stake was locked, the new model treats acceptance as the only active in-progress state.                                                                                   |
| `STARTED`     | `ACCEPTED`                | Started quests are functionally in-progress and should map to accepted.                                                                                                      |

> Note: `FAILED` and `CANCELLED` are not directly supported by current schema, so any mapping must be validated by product policy. The migration itself will not preserve these semantics automatically.

## 5. NPCConversation analysis

### Why `npcId` becomes NOT NULL

The current schema defines `NPCConversation.npc` as a required relation:

- `npc      NPC      @relation("npcConversations", fields: [npcId], references: [id], onDelete: Cascade)`
- `npcId     String`

The migration enforces this by setting `npcId` NOT NULL and re-adding the foreign key.

### Risk

- Existing `NPCConversation` rows with `npcId IS NULL` will block the migration.

### Safe inspection SQL

```sql
SELECT COUNT(*)
FROM "NPCConversation"
WHERE "npcId" IS NULL;
```

### Additional check

```sql
SELECT COUNT(*)
FROM "NPCConversation"
WHERE "npcId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "NPC" WHERE "NPC"."id" = "NPCConversation"."npcId");
```

## 6. Recovery options

### Option A: Fix data then deploy migration

- Risk level: Medium
- Data loss risk: Low to Medium
- Downtime risk: Low
- Recommended: Yes, if production data can be corrected safely before migration.

Steps:

1. Identify legacy `Quest.status` rows.
2. Convert them to supported statuses using an explicit SQL update or migration script.
3. Null-check `NPCConversation.npcId` rows and either delete, fill with valid NPC IDs, or move them to a staging table.
4. Re-run `prisma migrate deploy`.

### Option B: Mark migration rolled back and create corrective migration

- Risk level: Medium to High
- Data loss risk: Low if done carefully
- Downtime risk: Medium
- Recommended: Yes, if the failed migration must be bypassed cleanly and the current history is safe to preserve.

Steps:

1. Use `prisma migrate resolve --rolled-back 20260608085841_init` on the production DB.
2. Create a new migration that first normalizes legacy statuses and ensures `NPCConversation.npcId` integrity.
3. Apply the new migration with `prisma migrate deploy`.

### Option C: Create a data migration script before schema migration

- Risk level: Low
- Data loss risk: Low
- Downtime risk: Low to Medium
- Recommended: Best practice for production if you need a safe, reversible repair path.

Steps:

1. Deploy a standalone script or SQL script to convert legacy `Quest.status` values and clean `NPCConversation` rows.
2. Verify the script in a staging copy before production.
3. After data is clean, run `prisma migrate deploy`.

## 7. Recommended recovery path

**Recommended path:** Option C, then Option A.

Rationale:

- Data normalization should happen before schema migration in production.
- This avoids destructive enum conversion failures and ensures the database is compliant with the new enum set.
- If the data audit reveals corruption or null `npcId` rows, fix those first without applying schema changes.

Suggested order:

1. Run the audit queries in production.
2. Normalize legacy `Quest.status` values explicitly.
3. Fix or delete invalid `NPCConversation` rows.
4. Re-run `prisma migrate deploy`.
5. If deploy still fails, use `prisma migrate resolve --rolled-back 20260608085841_init` and create a corrected migration.

## 8. Online ForgeQuest compliance findings

### Required statuses present in schema

- `AVAILABLE`
- `ACCEPTED`
- `COMPLETED`
- `CLAIMABLE`
- `REWARDED`

### Compliance status

- The current Prisma schema supports the Online ForgeQuest status model.
- The schema still retains legacy fields and concepts from the AI/staking era, but these do not prevent status compliance.

### Legacy or residual schema elements

- `Quest.stakeAmount` remains present and is still used as a legacy acceptance/stake field.
- `Quest.maxRewardAmount` remains in schema, which is a security bound but may be legacy-adjacent.
- `Quest.chainQuestId`, `verificationTx`, `proofTxHash`, and `nftMintTx` are present; these are consistent with onchain and reward flows.
- `Quest.metadata`, `metadataUri`, and `orchestrationId` remain, indicating continued support for generated quest metadata and orchestrated flows.
- `NPCConversation`, `AgentIdentity`, `AgentMemory`, `NPCMemory`, and `WorldEvent` remain as production features, not necessarily directly part of the core quest status flow.
- Repo documentation still references Groq AI and AI generation, so AI-related capability appears to remain part of the architecture.

### Non-compliant or legacy concerns

- `stakeAmount` and the dropped `minStakeAmount` / `maxStakeAmount` columns signal residual staking architecture.
- `GROQ_API_KEY` and Groq/OpenAI references suggest AI quest generation is still intended, which may be OK if production is configured for it.
- The current `QuestStatus` set does not support old `FAILED` or `CANCELLED` semantics, meaning those rows require explicit handling before migration.

### Conclusion

This failure appears caused by legacy `QuestStatus` values and/or invalid `NPCConversation.npcId` rows, not by the new Online ForgeQuest schema itself.

A safe recovery starts with data inspection and normalization, then the migration should be retried once the production rows are aligned with the new enum and relational constraints.
