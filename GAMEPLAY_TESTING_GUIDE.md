# Online ForgeQuest - Gameplay Verification Testing Guide

**Date:** May 28, 2026  
**Objective:** Verify all gameplay flows work correctly with actual blockchain transactions  
**Environment:** Local development with Celo testnet/mainnet wallet

---

## PART 1: PRE-TESTING SETUP

### System Requirements

- [ ] Node.js 18+
- [ ] PostgreSQL running locally or accessible
- [ ] MetaMask or MiniPay wallet installed
- [ ] Test CELO (0.1+ CELO minimum for testing)
- [ ] Browser with web3 support (Chrome, Firefox, Brave)

### Environment Setup

1. **Backend Configuration**

   ```bash
   cd backend
   cp .env.example .env
   # Update DATABASE_URL to point to local PostgreSQL
   # Ensure CELO_RPC_URL=https://forno.celo.org (mainnet)
   npm install
   npx prisma generate
   npx prisma migrate deploy
   npm run start:dev
   ```

2. **Frontend Configuration**

   ```bash
   cd frontend
   npm install
   npm run dev
   # Should start on http://localhost:5173
   ```

3. **Wallet Setup**
   - [ ] Install MetaMask or MiniPay
   - [ ] Set network to Celo Mainnet (chainId 42220)
   - [ ] Fund wallet with test CELO (request testnet faucet OR use real CELO)
   - [ ] Note wallet address for tracking

### Database Setup

```bash
# Connect to local PostgreSQL
psql postgres

# Create database if not exists
CREATE DATABASE forgequest_local;

# Run migrations
cd backend
npx prisma migrate deploy
```

---

## PART 2: GAMEPLAY TEST SCENARIO #1 - Full Quest Flow

**Objective:** Verify complete quest lifecycle from generation to reward claim  
**Expected Duration:** 5-10 minutes  
**Wallet Balance Required:** 0.002 CELO minimum

### Test Steps

#### Step 1: Launch Application

- [ ] Open http://localhost:5173 in browser
- [ ] Verify home page loads
- [ ] Connect wallet (click "Connect Wallet")
  - [ ] Wallet extension opens
  - [ ] Select MetaMask or MiniPay
  - [ ] Approve connection request
  - [ ] Verify wallet address displayed in UI

**Log:** Take screenshot of wallet connection state

---

#### Step 2: Generate Quest (FREE)

- [ ] Click "Generate Quest" button
- [ ] Observe API call in browser console: `POST /api/quest/generate`
  - [ ] Check Network tab → Response includes questId, title, description, objectives, reward
  - [ ] Verify no transaction initiated
  - [ ] Verify CELO balance unchanged
- [ ] Quest should appear in feed with:
  - [ ] Title and description
  - [ ] Reward amount (in CELO)
  - [ ] Objectives list
  - [ ] "Accept Quest" button

**Expected API Response:**

```json
{
  "questId": "quest_123456",
  "title": "Retrieve the Ancient Artifact",
  "description": "...",
  "objectives": [...],
  "reward": "0.1",
  "minLevel": 1,
  "maxLevel": 5
}
```

**Log:** Copy API response from Network tab

---

#### Step 3: Accept Quest (0.001 CELO transaction)

- [ ] Click "Accept Quest" button on generated quest
- [ ] Wallet extension opens transaction approval
  - [ ] **CRITICAL:** Verify transaction shows **0.001 CELO** value
  - [ ] Verify `to:` address is ForgeQuestManager contract
  - [ ] Verify gas estimate
- [ ] Click "Confirm" to sign transaction
- [ ] Transaction submitted to Celo network
  - [ ] Observe transaction hash in UI
  - [ ] Observe transaction pending state
  - [ ] Wallet balance should show pending decrease of ~0.001 CELO

**Expected Transaction Details:**

```
To: 0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2 (ForgeQuestManager)
Value: 0.001 CELO
Data: createQuest(...)
Function: accept quest
```

**Verification Checkpoints:**

- [ ] Transaction confirms within 30-60 seconds
- [ ] Balance updated in UI: -0.001 CELO (plus gas)
- [ ] Quest status changes from "Available" to "Accepted"
- [ ] Backend receives registerOnchainQuest API call with chainQuestId
- [ ] Backend response includes: `{ chainQuestId: "0x...", status: "Accepted" }`

**Log:**

- Copy transaction hash from UI
- Copy console error/success messages
- Screenshot final balance

**Transaction Hash to Log:** ******\_******

---

#### Step 4: Complete Quest (NO transaction)

- [ ] Quest should now show "Submit Proof" button
- [ ] Click button to submit proof
- [ ] Input or select proof (implementation dependent):
  - [ ] Could be text input (e.g., "Proof URL")
  - [ ] Could be file upload
  - [ ] Could be form submission
- [ ] **CRITICAL:** Verify NO wallet transaction initiated
  - [ ] Wallet does NOT open
  - [ ] No transaction fee shown
  - [ ] No approval needed

**Expected Behavior:**

- [ ] Proof submitted via `POST /api/quest/submit-proof`
- [ ] Backend queues verification job
- [ ] UI shows "Proof Submitted" or "Waiting for Verification" state

**Log:**

- Copy API call details from Network tab
- Verify no transaction hash present
- Screenshot "Submitted" state

---

#### Step 5: Proof Verification (Backend Job Queue)

- [ ] Backend processes verification (15-30 seconds typical)
- [ ] Check backend logs:
  ```
  [Verification] Job processed for questId: quest_123456
  [Verification] Proof verified: true
  [Verification] Calling verifyQuest on contract...
  ```
- [ ] Contract calls verifyQuest:
  - [ ] Sets quest status to "Claimable"
  - [ ] Emits QuestVerified event

**Expected Timeline:**

- [ ] T+0s: Proof submitted
- [ ] T+15-30s: Backend processes and calls verifyQuest
- [ ] T+30-60s: Contract confirmed on Celo network

**Log:** Copy backend verification log timestamps

---

#### Step 6: Claim Reward (1 transaction)

- [ ] UI should show "Claim Reward" button
- [ ] Click "Claim Reward" button
- [ ] Wallet extension opens transaction approval
  - [ ] **CRITICAL:** Verify transaction shows reward amount (e.g., 0.1 CELO)
  - [ ] Verify `to:` address is Treasury or direct transfer
  - [ ] Verify NFT minting is included (check contract call)
- [ ] Click "Confirm" to sign transaction
- [ ] Observe transaction pending, then confirmed

**Expected Transactions:**

1. Treasury settlement: 0.1 CELO transfer
2. NFT minting: ERC721 mint call

**Verification Checkpoints:**

- [ ] Transaction confirms
- [ ] Reward CELO received in wallet (balance += 0.1 CELO approximately)
- [ ] NFT appears in wallet (check MetaMask NFT tab)
- [ ] Quest status changes to "Rewarded"
- [ ] Quest disappears from active feed
- [ ] Leaderboard updates (reputation +reward points)

**Log:**

- Copy claimReward transaction hash
- Screenshot final wallet balance
- Screenshot NFT in wallet

**Claimable Quest ID:** ******\_******  
**Claim Reward Transaction Hash:** ******\_******

---

### Test #1 Summary

**Financial Summary:**

- Generated: FREE (0 CELO)
- Accepted: -0.001 CELO (transaction fee)
- Completed: FREE (0 CELO)
- Submitted: FREE (0 CELO)
- Verification: FREE (0 CELO, backend only)
- **Claimed: +0.1 CELO (reward)**
- **Net Result: ~+0.099 CELO** (0.1 reward - 0.001 acceptance fee)

**Test Result:** [ ] ✅ PASS / [ ] ❌ FAIL

**Issues Encountered:**

```
[Please describe any issues here]
```

---

## PART 3: GAMEPLAY TEST SCENARIO #2 - Duplicate Reward Prevention

**Objective:** Verify that claiming the same quest reward twice is impossible  
**Expected Duration:** 2 minutes  
**Uses:** Quest from Test #1

### Test Steps

#### Step 2.1: Attempt Re-Claim

- [ ] Go back to completed quest in history
- [ ] Try to click "Claim Reward" again
- [ ] Expected behavior: Button disabled or error shown
  - [ ] "Already Claimed" message
  - [ ] Button shows gray/disabled state
  - [ ] No wallet transaction initiated

**Verification:**

- [ ] No transaction hash generated
- [ ] Error message clear: "You already claimed the reward for this quest"
- [ ] Wallet balance unchanged

**Test Result:** [ ] ✅ PASS / [ ] ❌ FAIL

---

## PART 4: GAMEPLAY TEST SCENARIO #3 - Daily Reward Claim

**Objective:** Verify daily reward claiming with once-per-day enforcement  
**Expected Duration:** 10 minutes (first claim + retry same day)

### Test Steps

#### Step 4.1: First Daily Reward Claim

- [ ] Navigate to "Daily Reward" section
- [ ] Click "Claim Daily Reward" button
- [ ] Wallet opens transaction
  - [ ] **CRITICAL:** Verify amount is **0.0001 CELO** exactly
  - [ ] Verify `to:` address is correct (Treasury or direct)
- [ ] Confirm transaction

**Expected Result:**

- [ ] Transaction succeeds
- [ ] Balance += 0.0001 CELO
- [ ] UI shows "Last claimed today"
- [ ] Shows next claim time: tomorrow at UTC 00:00

**Log:**

- First daily reward transaction hash: ******\_******
- Wallet balance after claim: ******\_******

---

#### Step 4.2: Retry Same UTC Day

- [ ] Try to claim daily reward again (same day)
- [ ] Expected behavior: Claim should be rejected
  - [ ] Error message: "Already claimed today. Next available at 2026-05-29 00:00:00 UTC"
  - [ ] No wallet transaction initiated
  - [ ] Button disabled or shows countdown

**Verification:**

- [ ] No transaction hash generated
- [ ] Wallet balance unchanged
- [ ] Error message references next UTC day

**Test Result:** [ ] ✅ PASS / [ ] ❌ FAIL

**Issues Encountered:**

```
[Please describe any issues here]
```

---

## PART 5: GAMEPLAY TEST SCENARIO #4 - Multiple Quest Cycle

**Objective:** Verify consistent behavior across multiple quests  
**Expected Duration:** 15 minutes

### Test Steps

#### Step 5.1: Generate and Complete 3 Quests

- [ ] Generate quest #2
- [ ] Accept quest #2 (verify 0.001 CELO transaction)
- [ ] Complete and claim quest #2 (verify reward received)
- [ ] Repeat for quest #3
- [ ] Repeat for quest #4

**Tracking:**

| Quest # | Generated | Accepted (0.001?) | Claimed | Reward | Notes |
| ------- | --------- | ----------------- | ------- | ------ | ----- |
| 2       | [ ]       | [ ]               | [ ]     | **\_** |       |
| 3       | [ ]       | [ ]               | [ ]     | **\_** |       |
| 4       | [ ]       | [ ]               | [ ]     | **\_** |       |

---

#### Step 5.2: Verify State Consistency

- [ ] Leaderboard shows cumulative rewards (sum of all quest rewards)
- [ ] Total CELO balance reflects: 3 rewards - 3 acceptance fees
- [ ] Reputation reflects number of completed quests
- [ ] No duplicate rewards visible
- [ ] All quests show "Rewarded" status

**Verification Checkpoints:**

- [ ] Leaderboard XP/reputation: should be sum of all quest rewards
- [ ] Balance math: (reward1 + reward2 + reward3) - (0.001 \* 3 acceptance fees)
- [ ] No transaction hash appears twice for same quest

**Test Result:** [ ] ✅ PASS / [ ] ❌ FAIL

---

## PART 6: ERROR SCENARIO TESTS

### Test 6.1: Insufficient Balance

- [ ] Manually transfer out most CELO
- [ ] Try to accept a quest
- [ ] Expected: Transaction fails with "Insufficient balance"
- [ ] Result: [ ] ✅ PASS / [ ] ❌ FAIL

### Test 6.2: Network Error Recovery

- [ ] Disconnect internet briefly during quest submission
- [ ] Expected: Error shown, can retry
- [ ] Result: [ ] ✅ PASS / [ ] ❌ FAIL

### Test 6.3: Wallet Rejection

- [ ] Try to claim reward, but reject in wallet
- [ ] Expected: Transaction cancelled, UI shows "Cancelled by user"
- [ ] Result: [ ] ✅ PASS / [ ] ❌ FAIL

---

## PART 7: SECURITY & PRODUCTION VERIFICATION

### Security Checks

- [ ] **Reentrancy Check:** Claim same quest twice rapidly (before first confirms)
  - Expected: Only one reward issued
  - Result: [ ] ✅ PASS / [ ] ❌ FAIL

- [ ] **Access Control Check:** Try to verify quest as non-verifier
  - Expected: Transaction fails with access denied
  - Result: [ ] ✅ PASS / [ ] ❌ FAIL

- [ ] **Input Validation:** Submit invalid proof URI
  - Expected: Backend rejects with error message
  - Result: [ ] ✅ PASS / [ ] ❌ FAIL

### Production Readiness

- [ ] [ ] Error messages are user-friendly (no stack traces)
- [ ] [ ] Loading indicators show during transaction pending
- [ ] [ ] Confirmation UI clear about what's happening
- [ ] [ ] No sensitive data (private keys, secrets) in console logs
- [ ] [ ] RPC failover works (if using multiple endpoints)
- [ ] [ ] Transaction recovery works after network hiccup

---

## FINAL VERIFICATION CHECKLIST

### Critical Path (Must All Pass)

- [ ] ✅ Generate quest successful (0 CELO)
- [ ] ✅ Accept quest successful (0.001 CELO transaction)
- [ ] ✅ Submit proof successful (0 CELO)
- [ ] ✅ Claim reward successful (1 transaction, reward transferred)
- [ ] ✅ Daily reward works (0.0001 CELO, once per day)
- [ ] ✅ Duplicate prevention works (can't re-claim)
- [ ] ✅ Leaderboard updates correctly

### Security Validation

- [ ] ✅ No reentrancy exploits possible
- [ ] ✅ No duplicate reward bugs
- [ ] ✅ No state corruption on errors
- [ ] ✅ Access control enforced

### Production Readiness

- [ ] ✅ Error handling works
- [ ] ✅ Loading states clear
- [ ] ✅ No stack traces in UI
- [ ] ✅ Transaction recovery works

---

## ISSUES LOG

### Issue Format

```
ID: [TEST-001]
Severity: [CRITICAL|HIGH|MEDIUM|LOW]
Location: [Component/Page]
Description: [What happened vs what was expected]
Steps to Reproduce: [Exact steps]
Expected Result: [What should happen]
Actual Result: [What actually happened]
Logs: [Console output, transaction hash, etc]
Status: [OPEN|IN-PROGRESS|FIXED|VERIFIED]
```

### Issues Found During Testing

[Issues to be logged here during actual testing]

---

## TEST EXECUTION LOG

**Test Start Time:** ******\_******  
**Test End Time:** ******\_******  
**Total Duration:** ******\_******

**Tests Passed:** **\_** / 7  
**Tests Failed:** **\_** / 7

**Overall Result:**

- [ ] ✅ ALL TESTS PASS - GAME READY FOR PRODUCTION
- [ ] ⚠️ SOME TESTS FAIL - ISSUES NEED FIXING
- [ ] ❌ CRITICAL FAILURES - CANNOT DEPLOY

**Sign-Off:** ************\_\_\_************  
**Date:** ************\_\_\_************

---

_This test guide ensures comprehensive verification of all gameplay mechanics and production readiness._
