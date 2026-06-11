# End-to-End Game Testing Guide - Complete Walkthrough

## 🎮 Test Objective

Verify the complete quest lifecycle works from start to finish now that Treasury is funded.

## ✅ Pre-Test Checklist

Before starting, confirm:

- [ ] Treasury funded with CELO (you confirmed this ✓)
- [ ] You have a test wallet (MetaMask or MiniPay) with some CELO
- [ ] Wallet is connected to Celo Mainnet (Chain ID: 42220)
- [ ] Production app: https://questforge-ai-chi.vercel.app

## 🧪 Complete Game Flow Test (Test 1 of 3)

### Step 1: Navigate to Game

1. Go to: https://questforge-ai-chi.vercel.app/command-center
2. Wait for page to load completely
3. You should see: "Enter the Forge - Connect your wallet"

### Step 2: Connect Wallet

1. Click **"Connect Wallet"** button
2. Choose your wallet (MetaMask or MiniPay)
3. Approve connection request
4. Wait for page to update (should show your wallet address)

**✅ Expected Result:**

- Wallet address shows in header
- "Connect Wallet" button changes to show your address
- Main panel shows: "Generating Your First Quest"

### Step 3: Generate Quest

1. Look for **"Generate Quest"** button (or similar)
2. Click it
3. Wait for quest to be generated (backend request, ~2-5 seconds)

**✅ Expected Result:**

- A quest appears with:
  - Title (e.g., "Daily Check-In")
  - Description
  - Reward amount (e.g., "0.010 CELO")
  - XP reward (e.g., "120 XP")
  - Duration (e.g., "2-3 min")
- Status shows: **"AVAILABLE"**
- Button shows: **"Accept Quest"**

### Step 4: Accept Quest (🔑 Critical Test)

1. Click **"Accept Quest"** button
2. **Watch for wallet popup** - This is the key fix!

**✅ Expected Result:**

- Wallet popup/modal appears immediately (MetaMask or MiniPay)
- Transaction details show:
  - Contract: ForgeQuestManager
  - Method: `createQuest`
  - Value: 0.001 CELO (acceptance fee)

### Step 5: Approve Transaction

1. In wallet popup, click **"Approve"** or **"Confirm"**
2. Wait for transaction to confirm (30-60 seconds)

**✅ Expected Result:**

- Wallet popup closes
- Game shows: "Accepting the quest onchain..."
- After confirmation: "Accepting the quest onchain. Syncing acceptance state with backend..."
- Quest status changes to: **"ACTIVE"**
- Button changes to: **"Submit Completion"**

### Step 6: Submit Proof

1. Look for **proof submission area** (usually a text input)
2. Enter a proof reference (e.g., a URL, transaction hash, or description)
3. Click **"Submit Completion"** button

**✅ Expected Result:**

- Another wallet popup appears
- Transaction details show method: `submitQuest`
- After approval:
  - Status changes to: **"SUBMITTED"**
  - Message: "Verification pending..."

### Step 7: Wait for Verification

Backend verifies the proof (usually takes 1-5 minutes)

**✅ Expected Result:**

- Quest status changes to: **"VERIFIED"**
- Button changes to: **"Claim Reward"**
- Message: "Reward ready to claim"

### Step 8: Claim Reward

1. Click **"Claim Reward"** button
2. Approve wallet transaction

**✅ Expected Result:**

- Wallet popup appears for reward claim
- After confirmation:
  - Status changes to: **"REWARDED"**
  - Message: "Reward settlement complete"
  - Your XP increases
  - Your CELO balance increases

## 📊 Test Results Summary

### Test 1 of 3 Completion Check

```
Checkpoint 1: Wallet Connection         ☐ Pass ☐ Fail
Checkpoint 2: Quest Generation          ☐ Pass ☐ Fail
Checkpoint 3: Accept Quest Trigger      ☐ Pass ☐ Fail (🔑 CRITICAL)
Checkpoint 4: Wallet Approval           ☐ Pass ☐ Fail
Checkpoint 5: Status Update to ACTIVE   ☐ Pass ☐ Fail
Checkpoint 6: Proof Submission          ☐ Pass ☐ Fail
Checkpoint 7: Verification & Reward     ☐ Pass ☐ Fail
Checkpoint 8: Reward Claim              ☐ Pass ☐ Fail

Overall Result: ☐ Complete Success ☐ Failed at Step ___
```

## 🔍 What to Watch For

### ✅ Good Signs (Fix Working)

- [ ] Wallet popup appears **immediately** when clicking "Accept Quest"
- [ ] No error messages appear
- [ ] Transaction completes successfully
- [ ] Quest status progresses: AVAILABLE → ACTIVE → SUBMITTED → VERIFIED → REWARDED
- [ ] Wallet balance shows transaction fees

### 🚩 Problems (If Any)

- [ ] Wallet popup doesn't appear after 3 seconds
- [ ] Error message: "Insufficient treasury liquidity"
- [ ] Transaction stuck in "pending" state for >2 minutes
- [ ] Quest status stays on same step

## 🧪 Test 2 & 3 - Repeat Flow

After Test 1 completes:

### Test 2: Different Quest Type

1. Generate a **new quest** (different category if possible)
2. Repeat steps 4-8
3. Confirm same flow works

### Test 3: Another Quest

1. Generate a third quest
2. Repeat steps 4-8
3. Confirm consistency

**User Requirement Met:** All 3 tests pass consistently ✓

## 📋 Error Troubleshooting

### Error 1: "Accepting..." hangs for >1 minute

**Possible Cause:** Network delay or backend issue
**Solution:**

1. Refresh page
2. Check if quest was actually created (check profile/inventory)
3. Try again

### Error 2: Wallet popup doesn't appear

**Possible Cause:**

- Wrong network
- Wallet not connected
- Contract not initialized

**Solution:**

1. Check wallet shows Celo Mainnet (42220)
2. Disconnect and reconnect wallet
3. Hard refresh: Ctrl+Shift+R
4. Try again

### Error 3: "Insufficient treasury liquidity"

**This should NOT happen now** - Treasury is funded
**If it does happen:**

1. Check: https://celoscan.io/address/0xEdFdE2946D0D31a636CE115d0026Ce6096957D5B
2. Verify balance shows the CELO you funded
3. Contact support if balance is 0

### Error 4: Transaction fails in wallet

**Possible Cause:**

- Insufficient gas
- Low wallet balance
- Wrong network

**Solution:**

1. Ensure wallet has at least 0.002 CELO (0.001 for quest + gas)
2. Ensure on Celo Mainnet
3. Try again

## 🎯 Success Criteria

✅ **Fix is verified successful when:**

1. Accept Quest button triggers wallet popup immediately
2. Transaction completes successfully
3. All 3 test runs complete without the "Insufficient treasury liquidity" error
4. Quest progresses through all stages to REWARDED
5. Player receives CELO reward in wallet

## 📊 Detailed Test Log Template

For each test, record:

```
TEST #: 1 / 2 / 3

Quest Generated:
  - Title: ________________
  - Reward: ________________ CELO
  - Duration: ________________

Accept Quest:
  - Wallet Popup Appeared: ☐ Yes ☐ No
  - Time to Appear: _______ seconds
  - Transaction Hash: 0x_______________________________

Submission:
  - Proof Submitted: ☐ Yes ☐ No
  - Transaction Hash: 0x_______________________________

Verification:
  - Status: ☐ ACTIVE ☐ SUBMITTED ☐ VERIFIED ☐ REWARDED
  - Time to Verify: _______ seconds

Final Result:
  ☐ Complete Success
  ☐ Partial Success (got to step ___)
  ☐ Failed at step ___
  - Error Message: ________________________

Notes:
________________________________________
________________________________________
```

## 🚀 Once All Tests Pass

If all 3 tests complete successfully:

1. ✅ **Fix is confirmed working**
2. ✅ **Accept Quest wallet trigger is fixed**
3. ✅ **Treasury liquidity error is resolved**
4. ✅ **Complete game loop works end-to-end**

Then proceed to:

- [ ] Test with multiple players
- [ ] Monitor Treasury balance
- [ ] Set up alerts for low liquidity
- [ ] Prepare production launch

## 📞 Reporting Results

When done with all 3 tests, please report:

1. Did all 3 tests complete? ☐ Yes ☐ No
2. At which step did they fail (if any)? \_\_\_
3. Any error messages? \_\_\_
4. Overall assessment: Fix works? ☐ Yes ☐ No

---

**You've already confirmed Treasury is funded. Now just test the game flow and let me know if all 3 tests complete successfully!** 🎯
