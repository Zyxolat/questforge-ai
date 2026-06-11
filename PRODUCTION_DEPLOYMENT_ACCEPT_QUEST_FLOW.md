# Production Deployment: Accept Quest Flow Refactor

**Status**: Ready for deployment  
**Date**: June 2026  
**Changes**: Refactored Accept Quest to use dedicated `acceptQuest()` function instead of embedding acceptance in `createQuest()`

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Key Changes](#key-changes)
3. [Pre-Deployment Verification](#pre-deployment-verification)
4. [Contract Deployment Steps](#contract-deployment-steps)
5. [Backend Deployment Steps](#backend-deployment-steps)
6. [Frontend Deployment Steps](#frontend-deployment-steps)
7. [Database Migration Strategy](#database-migration-strategy)
8. [Monitoring & Rollback](#monitoring--rollback)
9. [Post-Deployment Validation](#post-deployment-validation)

---

## Executive Summary

This deployment introduces a critical refactoring of the quest acceptance flow on-chain:

**Before**: `createQuest()` collected 0.001 CELO fee + handled quest acceptance in a single call
**After**:

- `createQuest()` creates AVAILABLE quests (no fee, no player set)
- NEW `acceptQuest(questId)` collects 0.001 CELO fee and sets player + acceptance timestamp

**Benefits**:

- ✅ Clearer on-chain semantics (quest creation ≠ quest acceptance)
- ✅ Multiple players can accept the same quest without re-creating it
- ✅ Better event separation (QuestCreated vs QuestAccepted)
- ✅ Backend event decoder already updated to recognize QuestAccepted
- ✅ Frontend UI already calls acceptQuest() instead of createQuest()

**Risk Level**: **MEDIUM** — State transition change; requires coordination between frontend and contracts

---

## Key Changes

### Smart Contracts

**File**: `contracts/contracts/ForgeQuestManager.sol`

**Modified Functions**:

- `createQuest()` — Now creates AVAILABLE (no player, no fee collected, startedAt=0)
- NEW `acceptQuest(uint256 questId)` — Payable, requires exactly 0.001 CELO, sets ACCEPTED state + player + startedAt

**New Event**:

- `event QuestAccepted(uint256 indexed questId, address indexed player, uint256 acceptedAt)`

**No changes to**:

- `submitProof()` — Still works with ACTIVE quests (set by acceptance)
- `claimReward()` — Still works with VERIFIED quests
- Treasury payout logic — Unchanged

### Frontend

**File**: `frontend/src/pages/CommandCenter.tsx`

**Modified Functions**:

- `handleAcceptQuest()` — Now calls `acceptQuest(chainQuestId)` instead of `createQuest()` with full params
- `submitForgeWrite()` — Updated to accept 'acceptQuest' as valid functionName
- `formatTxLabel()` — Maps 'acceptQuest' to "Accept quest" label

**Updated ABI**:

- Added `acceptQuest(uint256 questId)` function signature
- Added `QuestAccepted` event signature

### Backend

**File**: `backend/src/services/eventDecoder.ts`

**Modified**:

- Added `QuestAccepted` to QUEST_MANAGER_ABI event list
- Decoder case: Maps QuestAccepted → eventType 'quest_started' (reuses existing quest_started handler)
- Extracts playerWallet and acceptedAt timestamp

**No changes to**:

- Event projector logic
- Database schema (Quest.playerAddress already existed)
- API endpoints

---

## Pre-Deployment Verification

### ✅ Code Review Checklist

- [x] Contract: `createQuest()` creates AVAILABLE (no fee)
- [x] Contract: `acceptQuest()` requires ACCEPTANCE_FEE (0.001 ether)
- [x] Contract: Both functions emit correct events
- [x] Frontend: `handleAcceptQuest()` calls `acceptQuest()`
- [x] Frontend: Environment variables configured for target network
- [x] Backend: Event decoder recognizes QuestAccepted
- [x] Backend: .env has correct contract addresses

### ✅ Local Testing Done

- [x] Hardhat deployment successful (all 4 contracts)
- [x] On-chain create→accept flow tested with 2 signers
- [x] QuestAccepted event verified to emit with correct args
- [x] Frontend build passes TypeScript
- [x] Backend build passes TypeScript

### ⚠️ Pre-Flight Checks (Before Deployment)

- [ ] Postgres database ready (schema migrated)
- [ ] No active player quests in ACTIVE state on production (or manual migration plan)
- [ ] Rollback plan prepared (keep old contract addresses for fallback)
- [ ] Team notified of deployment window

---

## Contract Deployment Steps

### Option A: Deploy New Contracts (RECOMMENDED)

**Prerequisite**: Celo mainnet RPC access, deployer wallet funded with CELO

**Steps**:

1. **Prepare environment**:

   ```bash
   cd contracts
   cat > .env.mainnet << 'EOF'
   CELO_RPC_URL=https://forno.celo.org/  # or your Celo RPC
   DEPLOYER_PRIVATE_KEY=0x<your-private-key>  # Deploy account
   VERIFIER_PRIVATE_KEY=0x<verifier-key>      # Verification account
   EOF
   ```

2. **Deploy to Celo mainnet**:

   ```bash
   npx hardhat run scripts/deploy.ts --network celo
   ```

3. **Capture deployment output**:
   - FORGE_QUEST_MANAGER_ADDRESS
   - REWARD_NFT_ADDRESS
   - TREASURY_ADDRESS
   - REPUTATION_ADDRESS
   - DEPLOYMENT_BLOCK (for indexing)

4. **Verify on Celoscan**:
   - Navigate to each contract on https://celoscan.io
   - Verify source code using Hardhat verification plugin
   - Confirm state: Treasury funded, roles assigned

### Option B: Reuse Existing Contracts (If No Schema Changes)

**Only if** the existing contract already has the separate create/accept flow.

**Steps**:

1. Determine existing contract addresses
2. Verify contract bytecode matches new version
3. If versions differ, must use Option A

**Recommended**: Use Option A for safety.

---

## Backend Deployment Steps

### Step 1: Update Railway Environment Variables

**File**: Railway project dashboard → Environment Variables

| Variable                      | Old Value          | New Value                 | Notes                  |
| ----------------------------- | ------------------ | ------------------------- | ---------------------- |
| `FORGE_QUEST_MANAGER_ADDRESS` | `0x...` (old)      | `0x...` (from deployment) | Update to new contract |
| `REWARD_NFT_ADDRESS`          | `0x...` (old)      | `0x...` (from deployment) | Update to new contract |
| `TREASURY_ADDRESS`            | `0x...` (old)      | `0x...` (from deployment) | Update to new contract |
| `REPUTATION_ADDRESS`          | `0x...` (old)      | `0x...` (from deployment) | Update to new contract |
| `CELO_RPC_URL`                | (if using local)   | `https://forno.celo.org/` | Ensure mainnet RPC     |
| `CELO_CHAIN_ID`               | `31337` (local)    | `42220` (mainnet)         | Update to mainnet ID   |
| `ENABLE_EVENT_STREAM`         | (should be `true`) | `true`                    | Ensure indexing active |

### Step 2: Deploy Backend Code

1. **Merge to main branch**:

   ```bash
   git push origin main
   ```

2. **Railway auto-deploys** (or manually trigger in Railway dashboard)

3. **Monitor deployment**:
   - Watch logs for "Event stream started"
   - Verify no database migration errors

### Step 3: Verify Backend Started

```bash
# SSH to Railway backend or check logs
curl http://api.backend/health

# Expected response:
# {"status": "ok", "eventStream": true}
```

---

## Frontend Deployment Steps

### Step 1: Create Frontend Environment Configuration

**File**: `.env.production` (or environment variables in deployment platform)

```env
VITE_API_BASE_URL=https://api.backend-url/api    # Your Railway backend URL
VITE_CELO_CHAIN_ID=42220                          # Mainnet chain ID
VITE_CELO_RPC_URL=https://forno.celo.org/        # Celo mainnet RPC
VITE_CELO_EXPLORER_BASE_URL=https://celoscan.io  # Celo explorer
VITE_FORGE_QUEST_MANAGER_ADDRESS=0x...          # From deployment
VITE_REWARD_NFT_ADDRESS=0x...                     # From deployment
VITE_REPUTATION_ADDRESS=0x...                     # From deployment
VITE_TREASURY_ADDRESS=0x...                       # From deployment
```

### Step 2: Build and Deploy

```bash
cd frontend

# Build
npm run build

# Deploy to hosting (Vercel, Netlify, or Railway frontend service)
# Platform-specific deployment command here
```

### Step 3: Verify Frontend

1. Open https://questforge.app (or your frontend URL)
2. Connect wallet
3. Verify wallet network = Celo mainnet
4. Verify contract addresses in browser console:
   ```javascript
   console.log(
     "FORGE_QUEST_MANAGER:",
     import.meta.env.VITE_FORGE_QUEST_MANAGER_ADDRESS,
   );
   ```

---

## Database Migration Strategy

### Option A: Fresh Database (Recommended for New Deployment)

1. **Ensure new Postgres database** is set up
2. **Run Prisma migrations**:
   ```bash
   cd backend
   npx prisma migrate deploy
   ```
3. **No data loss concern** — Quest data will be populated as events stream in

### Option B: Migrate Existing Database

**If migrating from old deployment**:

1. **Backup existing database**:

   ```bash
   pg_dump <old-db> > backup.sql
   ```

2. **Plan for quest state inconsistency**:
   - Old system: quests in ACTIVE state with "stake locked"
   - New system: quests in ACTIVE state without locked stake
   - Recommendation: Clear ACTIVE quests before cutover, or manually mark for manual resolution

3. **Run migrations**:

   ```bash
   npx prisma migrate deploy
   ```

4. **Verify schema**:
   ```bash
   npx prisma studio
   ```

### ⚠️ Data Consistency Considerations

**Existing Quests** (before deployment):

- Will be in unknown state (database only; not re-synced)
- **Plan**: Inform users to finish or abandon old quests before cutover
- **Or**: Run backend indexer from earliest block after deployment to re-sync all events

**New Quests** (after deployment):

- Will be created as AVAILABLE (no fee)
- Will be accepted via acceptQuest() with 0.001 CELO
- Event stream will populate database correctly

---

## Monitoring & Rollback

### Monitoring During/After Deployment

**Key Metrics to Watch**:

1. **Backend**:
   - Event stream running: `tail -f railway-logs | grep "Event stream"`
   - No event decoder errors: `tail -f railway-logs | grep -i "error"`
   - QuestAccepted events appearing: `tail -f railway-logs | grep "QuestAccepted"`

2. **Frontend**:
   - Page loads without errors
   - Wallet connection works
   - Accept quest button triggers transaction

3. **On-Chain**:
   - Monitor Celoscan for new quest creation/acceptance txs
   - Verify QuestAccepted events appear

### Quick Rollback Plan

**If critical issue found within first hour**:

1. **Stop backend** (Railway → Service → Stop)
2. **Revert to old contract addresses** in Railway env vars
3. **Redeploy backend**
4. **Frontend** auto-reverts on refresh (reads env from backend or CDN)

**If database corrupted**:

1. Restore from backup: `psql < backup.sql`
2. Restart backend
3. Monitor event stream for inconsistencies

---

## Post-Deployment Validation

### ✅ Acceptance Test Checklist

Run this test scenario on production after deployment:

1. **Create Quest**:
   - [ ] Quest creator (dev wallet #1) visits frontend
   - [ ] Clicks "Generate New Quest"
   - [ ] Observes quest appears as AVAILABLE
   - [ ] Backend database shows status = 'AVAILABLE'

2. **Accept Quest**:
   - [ ] Acceptor (dev wallet #2) visits frontend
   - [ ] Clicks "Accept Quest" on same quest ID
   - [ ] Transaction shows 0.001 CELO + gas
   - [ ] Observes acceptance confirmation
   - [ ] Backend logs show `QuestAccepted` event decoded
   - [ ] Database shows status = 'ACCEPTED', playerAddress = wallet #2

3. **Submit Proof**:
   - [ ] Acceptor completes objective
   - [ ] Submits proof (transaction hash or explorer link)
   - [ ] Backend verifies proof
   - [ ] Database shows status = 'VERIFIED'

4. **Claim Reward**:
   - [ ] Click "Claim Reward"
   - [ ] Wallet receives reward amount (check Celoscan)
   - [ ] NFT minted to acceptor wallet
   - [ ] XP credited in backend

### ✅ Monitoring Checklist

**First 24 hours**:

- [ ] Monitor backend logs for errors
- [ ] Track accept quest transaction success rate
- [ ] Verify event stream processing latency (<5s)
- [ ] Check database query performance (no slow queries)

**First 7 days**:

- [ ] Collect telemetry on quest creation/acceptance ratio
- [ ] Monitor for transaction failures
- [ ] Check user feedback for UX issues
- [ ] Verify database storage growth is linear

---

## Rollback Decision Tree

| Scenario                                           | Action                                                                                                                     | Timeline |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------- |
| QuestAccepted not appearing in database            | Check event decoder logs; verify event is emitting on-chain; if decoder broken, revert backend                             | <1 hour  |
| Wallet balance error messages                      | Check if contract address is correct in frontend env; verify RPC is mainnet                                                | <1 hour  |
| Acceptance txs failing with "insufficient balance" | Likely gas estimation issue or real balance low; check contract acceptance fee (0.001); use QA wallet with sufficient CELO | <1 hour  |
| Multiple users affected, can't create/accept       | Revert contracts to old addresses; revert backend env vars; wait 5 min for frontend cache invalidation                     | <5 min   |
| Database corrupted                                 | Restore from backup; restart backend                                                                                       | <10 min  |

---

## Deployment Checklist

**Phase 1: Pre-Deployment (1 week before)**

- [ ] Final code review complete
- [ ] All tests passing
- [ ] Rollback plan documented
- [ ] Team communication sent

**Phase 2: Deployment Day (morning)**

- [ ] Backup production database
- [ ] Deploy contracts to mainnet
- [ ] Capture contract addresses
- [ ] Update Railway env vars
- [ ] Deploy backend (auto-redeploy on git push)

**Phase 3: Validation (after deployment)**

- [ ] Run acceptance test checklist
- [ ] Monitor logs for 1 hour
- [ ] Gather user feedback

**Phase 4: Post-Deployment (next week)**

- [ ] Final monitoring report
- [ ] Document any issues discovered
- [ ] Plan for minor fixes if needed

---

## Additional Resources

- **Local Testing Guide**: See [FINAL_PRE_SUBMISSION_AUDIT_JUNE2026.md](/memories/repo/FINAL_PRE_SUBMISSION_AUDIT_JUNE2026.md)
- **Contract ABI Updates**: See `frontend/src/lib/contracts.ts` for latest event signatures
- **Event Decoder**: See `backend/src/services/eventDecoder.ts` for QuestAccepted mapping
- **Railway Docs**: https://docs.railway.app/

---

## Sign-Off

**Prepared by**: AI Assistant  
**Date**: 2026-06-11  
**Status**: Ready for Production Deployment  
**Reviewed by**: [Your Name Here]  
**Approved by**: [Your Name Here]
