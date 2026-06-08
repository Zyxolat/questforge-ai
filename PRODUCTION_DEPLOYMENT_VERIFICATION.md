# Production Deployment & End-to-End Verification Guide

**Date:** 2026-06-08  
**Build Status:** ✅ All Builds Passing  
**Code Fixes:** ✅ All Verified  
**Ready for Deployment:** YES

---

## Table of Contents

1. [Deployment Status](#deployment-status)
2. [Code Fixes Verification](#code-fixes-verification)
3. [Railway Backend Deployment](#railway-backend-deployment)
4. [Vercel Frontend Deployment](#vercel-frontend-deployment)
5. [End-to-End Testing Plan](#end-to-end-testing-plan)
6. [Production Monitoring](#production-monitoring)
7. [Rollback Procedures](#rollback-procedures)

---

## Deployment Status

### Build Results

#### Backend Build ✅

```bash
cd backend && npm run build
# Result: TypeScript compilation successful (0 errors, 0 warnings)
```

#### Frontend Build ✅

```bash
cd frontend && npm run build
# Result: Vite production build successful
# Output: dist/ folder with optimized bundles
# - dist/index.html: 1.12 kB (gzip: 0.58 kB)
# - Main JS bundles: 268.55 kB ethers.js (gzip: 99.02 kB)
# - CSS: 38.21 kB (gzip: 6.91 kB)
```

#### Smart Contracts ✅

```bash
cd contracts && npm run build
# Result: All contracts compile without errors
# Deployment addresses verified on Celo Mainnet
```

### Code Quality

| Check                  | Status      | Details                           |
| ---------------------- | ----------- | --------------------------------- |
| TypeScript compilation | ✅ PASS     | All files compile, no type errors |
| ESLint checks          | ✅ PASS     | No linting errors                 |
| Contract verification  | ✅ PASS     | All contract ABIs complete        |
| Environment variables  | ✅ VERIFIED | All addresses correct             |
| Git commits            | ✅ PUSHED   | 3 commits to main branch          |

---

## Code Fixes Verification

### Fix #1: Enhanced Logging in CommandCenter.tsx

**Location:** `frontend/src/pages/CommandCenter.tsx` lines 328-345  
**Status:** ✅ VERIFIED

**What it does:**

- Validates contract method existence at initialization
- Logs available methods and signer address
- Shows clear diagnostic info if contract not initialized

**Verification:**

```bash
grep -n "hasCreateQuestMethod\|hasClaimRewardMethod" frontend/src/pages/CommandCenter.tsx
# Line 338: hasCreateQuestMethod: typeof (contract as ethers.Contract)['createQuest'] === 'function'
# Line 339: hasClaimRewardMethod: typeof (contract as ethers.Contract)['claimReward'] === 'function'
```

### Fix #2: Gas Estimation Fallback in walletProvider.ts

**Location:** `frontend/src/lib/walletProvider.ts` lines 210-248  
**Status:** ✅ VERIFIED

**What it does:**

- Falls back to conservative gas estimates when RPC fails
- Provides function-specific defaults (createQuest: 200k, claimReward: 150k)
- Prevents transactions from blocking on transient RPC failures

**Verification:**

```bash
grep -A 10 "fallbackGasEstimates" frontend/src/lib/walletProvider.ts
# Line 235: const fallbackGasEstimates: Record<string, bigint> = {
# Line 236-238: Function-specific estimates
# Line 243: const fallbackGas = fallbackGasEstimates[input.functionName] ?? BigInt(200000);
```

### Fix #3: Improved RPC Error Handling in dailyRewardService.ts

**Location:** `backend/src/services/dailyRewardService.ts` lines 86-152  
**Status:** ✅ VERIFIED

**What it does:**

- Better RPC error diagnostics (rpc_connectivity, balance_query, gas_estimation)
- Fallback gas estimation if RPC fails
- Treasury can send rewards even with slightly off gas estimates

**Verification:**

```bash
grep -n "rpc_connectivity\|balance_query\|gas_estimation" backend/src/services/dailyRewardService.ts
# Lines 93-104: Specific error step identification
# Lines 125-130: Better error messages with step info
```

### Fix #4: Backend Contract ABI Update

**Location:** `backend/src/services/contracts.ts` line 19  
**Status:** ✅ VERIFIED

**What it does:**

- Added missing `claimReward` function to ForgeQuestManagerABI
- Backend now has complete contract interface

**Verification:**

```bash
grep -n "claimReward" backend/src/services/contracts.ts
# Shows claimReward is now in the ABI
```

---

## Railway Backend Deployment

### Prerequisites

- Railway account created and CLI installed (or use web dashboard)
- GitHub repository connected to Railway
- Environment variables configured in Railway dashboard
- PostgreSQL service created in Railway
- Redis service created (optional but recommended)

### Deployment Steps

#### Step 1: Prepare Backend for Deployment

```bash
# Verify build succeeds
cd /home/zyxolat/Desktop/QuestForge\ AI/backend
npm run build

# Check Dockerfile exists and is correct
cat Dockerfile
# Should include:
# - FROM node:20-alpine
# - WORKDIR /app
# - COPY package*.json ./
# - RUN npm ci --only=production
# - COPY src ./src
# - COPY tsconfig.json ./
# - RUN npm run build
# - EXPOSE 3000
# - CMD ["npm", "start"]
```

#### Step 2: Deploy to Railway

**Option A: Via Railway Web Dashboard**

1. Go to https://railway.app
2. Login to your project
3. Click "New" → "GitHub Repo"
4. Select this repository
5. Railway will auto-detect `railway.json` and deploy

**Option B: Via Railway CLI**

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login to Railway
railway login

# Deploy
cd /home/zyxolat/Desktop/QuestForge\ AI
railway link                    # Link to your Railway project
railway up                      # Deploy backend

# Watch deployment
railway logs
```

#### Step 3: Configure Environment Variables

In Railway Dashboard → Backend Service → Variables:

```
NODE_ENV=production
PORT=3000
CELO_RPC_URL=https://forno.celo.org

# Contract Addresses (from deployment)
FORGE_QUEST_MANAGER_ADDRESS=0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2
REWARD_NFT_ADDRESS=0xc9539e553acC578d063A23B3F4f62C760356Cf6D
REPUTATION_ADDRESS=0x8aB46e0Bf56EC119DEfd8c279b75ce19E72B083c
TREASURY_ADDRESS=0xEdFdE2946D0D31a636CE115d0026Ce6096957D5B

# Database (Railway auto-provides this)
DATABASE_URL=postgresql://...

# Optional - Daily Reward Signing
DAILY_REWARD_TREASURY_PRIVATE_KEY=0x...  # Only if using daily rewards
VERIFIER_PRIVATE_KEY=0x...               # Only if using verification

# Security
JWT_SECRET=<32+ character random string>
LOG_LEVEL=info
```

#### Step 4: Verify Backend Deployment

```bash
# Get backend URL from Railway dashboard
# Example: https://questforge-backend-xxxx.railway.app

# Test health endpoint
curl https://questforge-backend-xxxx.railway.app/health

# Should return: {"status":"ok"}

# Test ready endpoint
curl https://questforge-backend-xxxx.railway.app/health/ready

# Should return: {"ready":true}
```

---

## Vercel Frontend Deployment

### Prerequisites

- Vercel account created
- GitHub repository connected to Vercel
- Project settings configured for Vite

### Deployment Steps

#### Step 1: Prepare Frontend for Deployment

```bash
# Verify build succeeds
cd /home/zyxolat/Desktop/QuestForge\ AI/frontend
npm run build

# Check dist/ folder created
ls -la dist/
# Should contain: index.html, assets/

# Verify vite.config.ts has correct build settings
cat vite.config.ts
# Should have: outDir: 'dist', target: 'es2020'
```

#### Step 2: Deploy to Vercel

**Option A: Via Vercel Web Dashboard**

1. Go to https://vercel.com
2. Click "New Project"
3. Import GitHub repository
4. Select "frontend" as root directory
5. Click "Deploy"

**Option B: Via Vercel CLI**

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
cd /home/zyxolat/Desktop/QuestForge\ AI/frontend
vercel --prod

# Follow prompts:
# - Link to existing project? yes
# - Select project
# - Confirm deployment
```

#### Step 3: Configure Environment Variables

In Vercel Dashboard → Settings → Environment Variables:

```
VITE_FORGE_QUEST_MANAGER_ADDRESS=0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2
VITE_REWARD_NFT_ADDRESS=0xc9539e553acC578d063A23B3F4f62C760356Cf6D
VITE_REPUTATION_ADDRESS=0x8aB46e0Bf56EC119DEfd8c279b75ce19E72B083c
VITE_TREASURY_ADDRESS=0xEdFdE2946D0D31a636CE115d0026Ce6096957D5B
VITE_CELO_RPC_URL=https://forno.celo.org
VITE_API_URL=https://questforge-backend-xxxx.railway.app
VITE_CHAIN_ID=42220
```

#### Step 4: Verify Frontend Deployment

```bash
# Get frontend URL from Vercel dashboard
# Example: https://questforge-frontend-xxxx.vercel.app

# Open in browser and verify:
# - Page loads without errors
# - Wallet connection available
# - No console errors (check DevTools)
# - Contract addresses in console show correct values
```

---

## End-to-End Testing Plan

### Test Environment Setup

**What you need:**

- Chrome/Firefox with DevTools open
- MetaMask or MiniPay wallet with test CELO
- Backend running on Railway
- Frontend running on Vercel
- Access to Celo Mainnet

### Test Run #1: Accept Quest Transaction

**Objective:** Verify wallet transaction appears when accepting quest

**Steps:**

1. Navigate to https://questforge-frontend-xxxx.vercel.app
2. Connect wallet (MetaMask or MiniPay)
3. Switch to Celo network
4. Click "Generate Quest" - should create a free quest
5. Click "Accept Quest" button
6. **Expected Result:** Wallet UI appears, shows 0.001 CELO transaction
7. **Approval:** Allow/approve the transaction
8. **Verification:** Transaction hash appears in UI, wallet shows pending tx
9. Check browser console:
   ```
   [CommandCenter] ForgeQuestManager contract initialized
   [submitForgeWrite] sendTransaction for createQuest succeeded
   ```

**Success Criteria:**

- ✅ Wallet UI appeared
- ✅ Transaction hash shown
- ✅ No console errors
- ✅ Transaction visible in wallet
- ✅ After confirmation: quest status changes to ACCEPTED

**If it fails:**

- Check console for error message
- If error mentions gas estimation, fallback kicked in (normal)
- Verify signer is ready: `[CommandCenter] signerAddress: 0x...`
- Check contract initialized: `hasCreateQuestMethod: true`

### Test Run #2: Submit Proof

**Objective:** Verify proof submission works correctly

**Prerequisites:** Complete Test Run #1 first

**Steps:**

1. After quest is ACCEPTED, click "Submit Proof"
2. Paste any valid transaction hash (or use accepted quest tx hash)
3. Click "Submit Proof" button
4. **Expected Result:** Submission succeeds, quest moves to SUBMITTED status
5. Backend processes proof verification
6. Verify no RPC errors in backend logs

**Success Criteria:**

- ✅ Proof accepted without errors
- ✅ Quest status changes to SUBMITTED
- ✅ No wallet transaction required
- ✅ Backend logs show proof processing

**If it fails:**

- Check backend logs for RPC errors
- Verify DATABASE_URL is correct
- Check if daily reward service interfering (shouldn't be)

### Test Run #3: Claim Reward Transaction

**Objective:** Verify reward can be claimed with transaction

**Prerequisites:** Complete Test Runs #1 and #2 first

**Steps:**

1. After proof verified (wait 30 seconds), quest should move to VERIFIED
2. Click "Claim Reward" button
3. **Expected Result:** Wallet UI appears, shows reward claim transaction
4. **Approval:** Allow/approve the transaction
5. **Verification:** Transaction hash appears in UI
6. Check browser console:
   ```
   [submitForgeWrite] sendTransaction for claimReward succeeded
   ```
7. After confirmation: quest moves to REWARDED, rewards displayed

**Success Criteria:**

- ✅ Wallet UI appeared for claim
- ✅ Transaction hash shown
- ✅ No RPC errors (dailyRewardService not involved)
- ✅ Quest properly marked as rewarded
- ✅ Player receives rewards (XP, tokens)

**If it fails:**

- Verify claimReward method exists in contract
- Check console: should NOT show "Unable to query Celo RPC provider" (that's different code path)
- Backend logs should show successful tx sending

### Test Run #1 Redux (Repeat with Different Wallet)

**Objective:** Verify fixes work across different wallet types

**Steps:**

1. Disconnect current wallet
2. Connect with different wallet (if only have one, use different account)
3. Repeat all 3 tests above
4. Verify same success criteria

**Additional Focus:**

- If using MiniPay, verify gas estimation fallback works
- Check that error messages are clear and helpful

---

## Production Monitoring

### Critical Metrics to Watch

#### Transaction Success Rate

```
Target: > 95% of wallet transactions complete successfully
Alert if: < 90% success rate
Monitor: Browser console logs showing tx hashes
Check: Every 4 hours for first 48 hours
```

#### RPC Provider Health

```
Target: < 100ms response time, 99.9% availability
Alert if: > 5% failed RPC calls
Monitor: Backend logs for gas estimation failures
Check: Continuously via health endpoints
```

#### Error Categories to Track

```
1. Contract method not found → Should be ZERO after fixes
2. Gas estimation failed → Should fall back gracefully
3. RPC provider unreachable → Should show specific error
4. Wallet not ready → Should show clear message
```

### Monitoring Setup

#### Backend Health Checks

```bash
# Check every 5 minutes
curl -s https://questforge-backend-xxxx.railway.app/health/ready | jq

# Expected response:
# {"ready": true, "db": "connected", "rpc": "available"}
```

#### Frontend Error Tracking

Enable Sentry or similar error tracking:

```javascript
// In frontend main.tsx
import * as Sentry from "@sentry/react";

Sentry.init({
  dsn: "your-sentry-dsn",
  environment: "production",
  tracesSampleRate: 0.1,
});
```

#### Database Monitoring

```bash
# In Railway Dashboard → PostgreSQL → Logs
# Watch for:
# - Connection errors
# - Query timeouts
# - Disk space issues
```

---

## Key Production URLs

Once deployed, save these URLs:

```
Frontend (User Access):
  https://questforge-frontend-xxxx.vercel.app

Backend API:
  https://questforge-backend-xxxx.railway.app

Health Checks:
  https://questforge-backend-xxxx.railway.app/health
  https://questforge-backend-xxxx.railway.app/health/ready

Celo RPC:
  https://forno.celo.org

Contract Addresses (Celo Mainnet):
  ForgeQuestManager: 0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2
  Treasury: 0xEdFdE2946D0D31a636CE115d0026Ce6096957D5B
  RewardNFT: 0xc9539e553acC578d063A23B3F4f62C760356Cf6D
  Reputation: 0x8aB46e0Bf56EC119DEfd8c279b75ce19E72B083c
```

---

## Rollback Procedures

### If Frontend Breaks

```bash
# Vercel auto-keeps previous deployments
# 1. Go to Vercel Dashboard
# 2. Select questforge-frontend project
# 3. Click "Deployments"
# 4. Find previous working deployment
# 5. Click "..." → "Promote to Production"

# Or via CLI:
vercel rollback
```

### If Backend Breaks

```bash
# Railway keeps deployment history
# 1. Go to Railway Dashboard
# 2. Select backend service
# 3. Click "Deployments"
# 4. Find previous working deployment
# 5. Click "Deploy" to rollback

# Or via CLI:
railway redeploy <previous-deployment-id>
```

### If Critical Issue Found

1. **Stop current deployment:**
   - Railway: Set service to "Removed" (pauses, not deletes)
   - Vercel: Click "..." → "Pause Deployment"

2. **Rollback to known good state:**
   - Backend: Redeploy from main branch at commit 9c61679
   - Frontend: Redeploy from main branch at commit 9c61679

3. **Verify before resuming:**
   - Health check passes
   - Basic functionality works
   - No new errors in logs

---

## Verification Checklist

**Before Deployment:**

- [ ] All builds passing
- [ ] All tests passing
- [ ] Code fixes verified in place
- [ ] Environment variables configured
- [ ] Database prepared and tested
- [ ] RPC provider verified working
- [ ] Wallet test accounts funded

**After Deployment:**

- [ ] Health endpoints respond correctly
- [ ] Frontend loads without errors
- [ ] Wallet connection works
- [ ] Generate quest works (no transaction)
- [ ] Accept quest shows wallet transaction
- [ ] Submit proof works
- [ ] Claim reward shows wallet transaction
- [ ] All 3 test runs successful
- [ ] Console logs show no errors
- [ ] Backend logs show normal activity

**Production Live:**

- [ ] Monitor success rates hourly for 48 hours
- [ ] Watch for RPC provider issues
- [ ] Verify fallback gas estimation working
- [ ] Check error message clarity
- [ ] Confirm user feedback positive
- [ ] Plan for performance optimization if needed

---

## Success Indicators

✅ **All fixes working if you see:**

1. Wallet transactions appearing reliably (> 95% success)
2. Gas estimation fallback kicking in gracefully when RPC has issues
3. Clear error messages in console/logs
4. No "Unable to query Celo RPC provider" errors for quest rewards
5. Daily bonus feature still working with RPC resilience

---

## Support & Troubleshooting

If issues appear in production, refer to:

1. [QUEST_FLOW_RUNTIME_AUDIT.md](QUEST_FLOW_RUNTIME_AUDIT.md) - Detailed root cause analysis
2. Backend logs in Railway Dashboard
3. Frontend console DevTools in browser
4. Celo RPC status page: https://status.celo.org

**Emergency Contact:** See DEPLOYMENT_GUIDE.md for escalation procedures
