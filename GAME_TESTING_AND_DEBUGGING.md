# QuestForge AI - Game Testing & Debugging Guide

## Overview

This guide provides comprehensive instructions for testing the QuestForge AI quest acceptance system and debugging any issues that arise.

---

## Part 1: Environment Setup & Prerequisites

### 1.1 Wallet Setup

Before testing, ensure you have:

**MetaMask Setup (Chrome/Firefox):**

```
1. Install MetaMask extension
2. Create or import test wallet
3. Add Celo network:
   - Network Name: Celo Testnet
   - RPC URL: https://alfajores-forno.celo-testnet.org
   - Chain ID: 44787
   - Currency: CELO
   - Explorer: https://alfajores-blockscout.celo-testnet.org
```

**Get Test CELO:**

- Go to: https://faucet.celo.org
- Enter wallet address
- Request 1 CELO (wait ~1 minute)
- Verify balance in MetaMask

**MiniPay Setup (Mobile - optional):**

```
1. Install MiniPay browser on mobile
2. Create account and fund with CELO (via Celo faucet)
3. Navigate to game URL
```

### 1.2 Development Environment

```bash
# Ensure Node.js v18+
node --version

# Install dependencies
npm install

# Start dev server
npm run dev
# Frontend: http://localhost:5173

# Keep backend running (separate terminal)
npm run dev:server
# Backend: http://localhost:5555
```

---

## Part 2: Quest Acceptance Flow Testing

### 2.1 Basic Quest Generation Test

**Objective:** Verify quest generation and wallet connection

**Steps:**

1. Open browser to http://localhost:5173
2. In console (F12 → Console tab), watch for logs
3. Click "Generate Quest"
4. ✅ **Expected Outcome:**
   - Random quest appears
   - Title, description visible
   - Reward amount shown (e.g., "10 CELO")
   - "Accept" button available

**Common Issues:**
| Issue | Solution |
|-------|----------|
| Blank page | Check backend running: `npm run dev:server` |
| "Connect Wallet" unavailable | Ensure MetaMask installed and on Celo Testnet |
| Quest not generating | Check browser console for API errors |

---

### 2.2 Quest Acceptance Flow Test

**Objective:** Test the full blockchain transaction for quest acceptance

**Steps:**

1. Have a generated quest visible (from 2.1)
2. Click the "Accept" button
3. Watch browser console for logs (should see):
   ```
   [handleAcceptQuest] Quest check: {questId: "...", status: "AVAILABLE"}
   [handleAcceptQuest] Wallet check: {address: "0x...", hasForgeQuestManager: true}
   [handleAcceptQuest] Calling submitForgeWrite with createAndAcceptQuest
   [CommandCenter] Calling createAndAcceptQuest with args: {
     title: "...",
     rewardAmount: "1000000000000000000",
     gasLimit: "500000",
     value: "1000000000000000"
   }
   ```
4. **Wallet popup appears** - Approve the transaction
5. Wait for confirmation (usually 5-10 seconds)

**✅ Success Criteria:**

- Wallet popup appears
- Transaction hash visible in logs
- Message: "Quest accepted on Celo! Now complete the objective..."
- Quest status changes to "ACCEPTED"
- Button changes to "Submit Proof"

**Expected Transaction Details:**

```
To: ForgeQuestManager contract
Value: 0.001 CELO (acceptance fee)
Gas Limit: 500000 wei
Function: createAndAcceptQuest(
  title,
  metadataUri,
  rewardAmount (in wei),
  xpReward,
  durationSeconds
)
```

---

### 2.3 Error Scenarios & Solutions

#### 2.3.1 "missing revert data" Error

**Console Log:**

```
Error accepting quest: missing revert data (action="estimateGas", ...)
```

**Root Causes & Solutions:**
| Cause | Check | Fix |
|-------|-------|-----|
| Insufficient CELO balance | MetaMask balance ≥ 0.002 CELO | Request more from faucet |
| Treasury underfunded | Check contract state | (Rare in testnet) |
| Not on Celo network | Check MetaMask network selector | Switch to Celo Testnet |
| Gas estimation still failing | Check logs for function call details | Fallback to 500k gas (applied) |

**New Detailed Error Messages:**

```
// If insufficient CELO:
"Transaction would fail - check you have enough CELO
(need >0.002 for fee + gas). Treasury may also need funding."

// If no CELO at all:
"Insufficient CELO balance. Need at least 0.002 CELO
(0.001 fee + gas)."

// If contract state issue:
"Transaction would fail - [detailed reason from contract]"
```

#### 2.3.2 "Execution Reverted" Error

**Console Log:**

```
Error accepting quest: Transaction reverted: [reason]
```

**Common Revert Reasons & Solutions:**

```solidity
// Revert: "Accept fee required"
→ Ensure value: 0.001 CELO is being sent
→ Check: txOptions.value === ethers.parseEther('0.001')

// Revert: "Insufficient reward in treasury"
→ Treasury contract balance too low
→ Check Treasury contract balance on block explorer

// Revert: "Unauthorized"
→ Player address not initialized
→ Should be auto-initialized by contract
```

#### 2.3.3 Wallet Not Connecting

**Symptoms:**

- "Connect Wallet" button shows but doesn't respond
- No MetaMask popup appears

**Solutions:**

```
1. Check MetaMask is installed and unlocked
2. Verify you're on Celo Testnet network
3. Check browser console for errors
4. Try refreshing page: Ctrl+Shift+R (hard refresh)
5. Clear browser cache and try again
```

---

## Part 3: Complete Game Flow Testing

### 3.1 Full Playthrough (3 Complete Cycles)

**Objective:** Verify entire quest lifecycle works end-to-end

**Playthrough 1: Basic Quest**

```
STEP 1: Generate Quest
└─ Click "Generate Quest"
└─ ✅ Quest appears with status: AVAILABLE

STEP 2: Accept Quest (Blockchain)
└─ Click "Accept"
└─ ✅ Wallet popup shows: 0.001 CELO fee
└─ ✅ Approve transaction
└─ ✅ Status changes to ACCEPTED
└─ ✅ Message: "Quest accepted on Celo!"

STEP 3: Complete Objective
└─ User completes quest objective in real world
└─ Example: "Do 10 pushups" → Actually do 10 pushups

STEP 4: Upload Proof (Blockchain)
└─ Click "Submit Proof"
└─ ✅ Wallet popup shows gas costs (no CELO fee)
└─ ✅ Approve transaction
└─ ✅ Status changes to SUBMITTED
└─ ✅ Message: "Proof submitted! Waiting for verification..."

STEP 5: Claim Reward (Blockchain)
└─ Wait for verification (instant in testnet usually)
└─ Click "Claim Reward"
└─ ✅ Wallet popup shows
└─ ✅ Approve transaction
└─ ✅ Status changes to COMPLETED
└─ ✅ CELO transferred to wallet
└─ ✅ XP added to player stats
└─ ✅ NFT minted (check inventory)
```

**Playthrough 2 & 3:**

- Repeat the same flow
- Verify all transactions complete successfully
- Check player stats accumulate (XP, level progression)
- Verify different quests each time

**Success Verification Checklist:**

- [ ] 3 quests created
- [ ] 3 quests accepted (3 transactions)
- [ ] 3 proofs submitted (3 transactions)
- [ ] 3 rewards claimed (3 transactions)
- [ ] Total: 9 blockchain transactions
- [ ] Player XP increased
- [ ] Wallet CELO balance changed
- [ ] NFTs appear in inventory

---

### 3.2 Multi-Quest Concurrent Testing

**Objective:** Verify multiple quests can be active simultaneously

**Steps:**

1. Generate Quest 1
2. Accept Quest 1 ✅
3. (Quest 1 now ACCEPTED)
4. Generate Quest 2
5. Accept Quest 2 ✅
6. (Now have 2 quests ACCEPTED)
7. Submit proof for Quest 1
8. Submit proof for Quest 2
9. Claim both rewards

**✅ Expected Outcome:**

- Can have multiple quests active
- Each tracks independently
- All transactions complete

---

## Part 4: Debugging Console Logs

### 4.1 Enable Debug Logging

**In Browser DevTools (F12):**

```javascript
// Show all logs including debug level
localStorage.debug = "*";
// Or more specific:
localStorage.debug = "[CommandCenter]*,[handleAcceptQuest]*";
```

### 4.2 Key Log Points to Monitor

**Quest Acceptance Flow:**

```
[handleAcceptQuest] Quest check:
  → Confirms quest status is AVAILABLE

[handleAcceptQuest] Wallet check:
  → Confirms wallet is connected and ready

[handleAcceptQuest] Calling submitForgeWrite with createAndAcceptQuest:
  → Shows quest parameters being sent

[CommandCenter] Calling createAndAcceptQuest with args:
  → Shows exact contract function call parameters
  → CRITICAL: Check gasLimit: "500000" is present
  → CRITICAL: Check value: "1000000000000000" (0.001 CELO)

[CommandCenter] Transaction submitted to wallet successfully:
  → ✅ If you see this, wallet accepted the transaction

[CommandCenter] Transaction confirmed:
  → ✅ If you see this, transaction mined on Celo
```

### 4.3 Common Debug Scenarios

**Debug: "Transaction didn't get submitted"**

```javascript
// Look for in console:
❌ [CommandCenter] Transaction submitted to wallet successfully
// If missing → Check logs above for error
// Common: Gas estimation failure → Fallback applied → Try again
```

**Debug: "Transaction submitted but never confirmed"**

```javascript
// Look for in console:
✅ [CommandCenter] Transaction submitted to wallet successfully
❌ [CommandCenter] Transaction confirmed
// If missing → Check Celo explorer
// Go to: https://alfajores-blockscout.celo-testnet.org
// Search for transaction hash from logs
// If shows "pending" → Wait longer
// If shows "failed" → Check revert reason
```

**Debug: "Player stats not updating"**

```javascript
// After claiming reward, verify in console:
// Should see logs for XP update and NFT minting
// Check: Inventory page shows new NFT
// Check: Player level increased
```

---

## Part 5: Celo Block Explorer Verification

### 5.1 Transaction Verification

**Access Block Explorer:**

- Go to: https://alfajores-blockscout.celo-testnet.org
- Search for transaction hash from console logs

**Verify Transaction Details:**

```
Expected for createAndAcceptQuest:
├─ Status: Success ✅
├─ From: [Your wallet address]
├─ To: ForgeQuestManager contract
├─ Value: 0.001 CELO
├─ Gas Used: < 500000
├─ Input Data: Function selector for createAndAcceptQuest
└─ Logs: QuestCreated event emitted
```

### 5.2 Contract Balance Verification

**Check Treasury Balance:**

```
1. Go to https://alfajores-blockscout.celo-testnet.org
2. Search for Treasury contract address
3. Click "Read Contract"
4. Call: `getBalance()`
5. Verify balance > 0 CELO
6. Note: Treasury should have received your 0.001 CELO fees
```

**Check ForgeQuestManager Contract:**

```
1. Search for ForgeQuestManager contract
2. Verify it's deployed
3. Check contract code is visible
```

---

## Part 6: If Issues Persist

### 6.1 Diagnostic Checklist

**Before reporting issues, verify:**

- [ ] MetaMask connected and on Celo Testnet (chainId: 44787)
- [ ] Wallet has ≥ 0.002 CELO
- [ ] Browser console shows no errors (F12 → Console)
- [ ] Backend running: `npm run dev:server` (status: 200 OK)
- [ ] Frontend running: `npm run dev` (http://localhost:5173)
- [ ] Contracts deployed (verify in console logs on page load)
- [ ] Internet connection stable
- [ ] Browser cache cleared (Ctrl+Shift+R)

### 6.2 Debug Commands

**In terminal:**

```bash
# 1. Verify build succeeds
npm run build

# 2. Run all tests (should show 70 passing)
npm run test

# 3. Check contract deployment info
npm run dev:server
# Check logs for contract addresses

# 4. Restart everything fresh
npm run clean
npm install
npm run build
npm run dev
# (in another terminal)
npm run dev:server
```

### 6.3 Collect Debug Info for Support

If you need to report an issue, collect:

1. **Browser Console Output:**
   - Screenshot or copy all logs from F12 → Console
   - Include any error messages

2. **Transaction Hash (if available):**
   - From browser console: `[CommandCenter] Transaction submitted...`
   - Allows checking status on Celo Explorer

3. **Wallet Address:**
   - Needed to verify balance and transaction history

4. **Steps to Reproduce:**
   - Exact sequence that caused the issue
   - Which button was clicked, what was expected vs. actual

5. **Environment Info:**
   ```bash
   node --version
   npm --version
   # Also note: Browser, OS, MetaMask version
   ```

---

## Part 7: Success Metrics

### When Everything Works ✅

You should see:

1. ✅ Quest generation works instantly
2. ✅ Accept button triggers wallet popup
3. ✅ Transaction submits and confirms (5-10 seconds)
4. ✅ Quest status updates to ACCEPTED
5. ✅ Can submit proof without issues
6. ✅ Can claim reward without issues
7. ✅ Player stats update (XP, level)
8. ✅ NFTs appear in inventory
9. ✅ Wallet balance decreases by 0.001 CELO per quest
10. ✅ No console errors or warnings

### After 3 Complete Playthroughs ✅

You should verify:

- [ ] 9 total blockchain transactions completed
- [ ] All transactions confirmed on Celo
- [ ] Player XP accumulated correctly
- [ ] Player level increased (if XP crossed threshold)
- [ ] 3 NFTs in inventory
- [ ] Wallet received 3x quest rewards
- [ ] No issues during any playthrough

---

## Part 8: Advanced Troubleshooting

### 8.1 Gas Limit Fallback Applied

**If you see this log:**

```
[CommandCenter] Gas limit not provided for createAndAcceptQuest, using fallback
```

**This means:**

- Gas estimation was skipped (normal with fallback in place)
- Using 500000 wei as gas limit
- This is a conservative estimate and should work
- If transaction still fails → Check revert reason on block explorer

### 8.2 Event Parsing

**If you see:**

```
[handleAcceptQuest] Could not find QuestCreated event, using quest ID
```

**This means:**

- Event parsing failed (rare, usually works)
- Using quest ID as fallback
- Transaction likely still succeeded
- Check block explorer to verify

### 8.3 Manual Transaction Check

**If transaction seems stuck:**

```javascript
// In browser console, check transaction:
// (Replace with hash from logs)
const hash = "0x...";

// Using ethers.js from window (if available):
const provider = new ethers.BrowserProvider(window.ethereum);
const receipt = await provider.getTransactionReceipt(hash);
console.log("Receipt:", receipt);

// Or visit block explorer:
// https://alfajores-blockscout.celo-testnet.org/tx/[hash]
```

---

## Summary

The quest acceptance system now includes:

1. **Gas Limit Fallback:** 500000 wei for createAndAcceptQuest
2. **Detailed Error Messages:** Clear guidance on what went wrong
3. **Enhanced Logging:** Track every step of the transaction
4. **3 Complete Playthroughs:** Verify end-to-end functionality

**Ready to test!** Follow Part 3 for a complete game flow verification.

For questions or issues, check Part 6 (Diagnostic Checklist) and Part 8 (Advanced Troubleshooting).
