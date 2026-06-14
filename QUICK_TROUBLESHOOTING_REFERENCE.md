# QuestForge AI - Quick Troubleshooting Reference

## Before You Start Testing

### Checklist (Must All Be ✅)

```
☑ MetaMask installed and unlocked
☑ Celo Testnet added to MetaMask
☑ Wallet address on Celo Testnet
☑ Have ≥ 0.002 CELO in wallet (from https://faucet.celo.org)
☑ Backend running (npm run dev:server)
☑ Frontend running (npm run dev) on http://localhost:5173
☑ Browser console open (F12 → Console tab)
```

---

## Common Issues & Quick Fixes

### ❌ Error: "missing revert data (action='estimateGas')"

**What it means:** Transaction would fail, but we don't know why yet.

**Quick fixes (in order):**

1. ✅ **Check wallet balance:** MetaMask shows ≥ 0.002 CELO
2. ✅ **Check network:** MetaMask shows "Celo Testnet" (chainId: 44787)
3. ✅ **Check browser console:** Look for any other error messages
4. ✅ **Reload page:** Ctrl+Shift+R (hard refresh)
5. ✅ **Get more CELO:** Request from https://faucet.celo.org again

**If still failing:**

- Check browser console for: `[CommandCenter] Calling createAndAcceptQuest with args:`
- Verify you see: `gasLimit: "500000"` in the logs
- If not present → Gas fallback not applied → Reload page

---

### ❌ Error: "Insufficient CELO balance"

**What it means:** Not enough CELO in wallet.

**Quick fixes:**

1. Check MetaMask wallet balance (click account icon)
2. Need: **0.002 CELO minimum** (0.001 fee + gas)
3. Get more: https://faucet.celo.org
4. Wait ~1 minute after requesting
5. Refresh page and try again

---

### ❌ Wallet Popup Doesn't Appear

**What it means:** MetaMask not connecting properly.

**Quick fixes:**

1. Check MetaMask is **unlocked** (not showing lock icon)
2. Check **Celo Testnet** is selected (not Ethereum)
3. Hard refresh page: **Ctrl+Shift+R**
4. Close and reopen MetaMask
5. Restart browser completely

**Advanced:** In browser console, check for:

```
[handleAcceptQuest] Wallet check: {
  address: "0x...",    ← Should show wallet address
  hasForgeQuestManager: true  ← Should be TRUE
}
```

---

### ❌ "Transaction submitted but never confirmed"

**What it means:** Transaction stuck on Celo network.

**Check status:**

1. Open browser console (F12)
2. Look for: `[CommandCenter] Transaction submitted to wallet successfully`
3. Copy the transaction hash shown in logs
4. Go to: https://alfajores-blockscout.celo-testnet.org
5. Search for the transaction hash
6. Check status:
   - 🟡 **"Pending"** → Wait 10-20 seconds more
   - ✅ **"Success"** → Transaction went through!
   - ❌ **"Failed"** → Transaction reverted (see below)

---

### ❌ Transaction Failed on Celo Explorer

**What it means:** Transaction was submitted but reverted.

**Check revert reason:**

1. On block explorer, click the failed transaction
2. Scroll to "Logs" section
3. Look for revert message (e.g., "Insufficient reward in treasury")

**Common revert reasons:**
| Revert Reason | Solution |
|---|---|
| "Accept fee required" | Contract didn't receive 0.001 CELO (bug) |
| "Insufficient reward in treasury" | Treasury contract underfunded (rare) |
| "Unauthorized" | Player initialization failed (rare) |
| "Quest not found" | Quest ID doesn't exist (reload page) |

---

### ❌ No Console Logs at All

**What it means:** Backend or frontend not running.

**Quick fixes:**

1. Check **backend running:** `npm run dev:server`
   - Should show: `Server running on port 5555`
2. Check **frontend running:** `npm run dev`
   - Should show: `VITE v... ready in ... ms`
3. Check **page loaded:** http://localhost:5173
   - Should show "Command Center" UI
4. Open **browser console:** F12 → Console tab
   - Should see initial logs: `[CommandCenter] Initializing...`

---

### ❌ Button Click Does Nothing

**What it means:** JavaScript event handler not responding.

**Quick fixes:**

1. Check console for errors (F12 → Console)
2. Check MetaMask is connected (MetaMask icon in browser)
3. Try hard refresh: **Ctrl+Shift+R**
4. Check developer console: Any red ❌ errors?
5. Restart backend: `npm run dev:server`

---

### ❌ Gas Limit Still Too Low

**What it means:** Even with 500000 fallback, transaction reverted.

**Check in block explorer:**

1. Go to transaction details
2. Scroll to "Gas" section
3. Check "Gas Used" vs "Gas Limit"
   - If **Gas Used > 450,000** → Need higher limit
   - If **Gas Used < 450,000** → Different issue

**Report this issue with:**

- Transaction hash
- Gas used (from explorer)
- Exact error message

---

## Success Indicators ✅

### After Clicking "Accept Quest"

You should see in browser console:

```
[handleAcceptQuest] Quest check: {...}
[handleAcceptQuest] Wallet check: {...}
[handleAcceptQuest] Calling submitForgeWrite with createAndAcceptQuest
[CommandCenter] Calling createAndAcceptQuest with args: {...}
[CommandCenter] Transaction submitted to wallet successfully {
  functionName: "createAndAcceptQuest",
  txHash: "0x..."
}
[CommandCenter] Transaction confirmed {...}
```

### After Transaction Confirmed

You should see:

```
Message: "Quest accepted on Celo! Now complete the objective and submit your proof."
Button changes from "Accept" to "Submit Proof"
Quest status shows: "ACCEPTED"
```

### After Full Playthrough (3 Times)

You should see:

```
✅ 3 quests created
✅ 3 quests accepted (wallet approvals worked)
✅ 3 proofs submitted (transactions confirmed)
✅ 3 rewards claimed (rewards received)
✅ Player XP increased
✅ NFTs in inventory
✅ Wallet CELO balance changed
```

---

## Browser Console Tips

### How to Open Console

- **Windows/Linux:** Press `F12` or `Ctrl+Shift+I`
- **Mac:** Press `Cmd+Option+I`
- Then click "Console" tab

### Viewing Logs

```
✅ Green text = Success logs
⚠️ Yellow text = Warnings
❌ Red text = Errors (BAD!)
🔵 Blue text = Info messages
```

### Copy Console Output (for support)

```
1. Right-click in console
2. Select "Save as..."
3. Choose location and save
4. Attach to support request
```

### Filter Logs

```javascript
// Show only QuestForge logs
localStorage.debug = "[CommandCenter]*";

// Show everything
localStorage.debug = "*";

// Clear filter
localStorage.debug = "";
```

---

## Block Explorer Verification

### Check Your Transaction

**URL:** https://alfajores-blockscout.celo-testnet.org/tx/[HASH]

**Replace [HASH] with transaction hash from console logs**

**What to look for:**

- ✅ **Status:** "Success" (green checkmark)
- ✅ **From:** Your wallet address
- ✅ **To:** ForgeQuestManager contract (check matches frontend)
- ✅ **Value:** 0.001 CELO (displayed as wei: 1000000000000000)
- ✅ **Gas Used:** < 500000
- ✅ **Logs:** Should see "QuestCreated" event

### Check Your Wallet Balance

**URL:** https://alfajores-blockscout.celo-testnet.org/address/[ADDRESS]

**Replace [ADDRESS] with your wallet address**

**What to look for:**

- ✅ **CELO Balance:** Updated after reward claim
- ✅ **Transactions:** Should show all your quest txs
- ✅ **Tokens:** Should show NFT rewards

---

## Getting Help

### 1. Collect Debug Information

```
☑ Your wallet address (MetaMask)
☑ Current CELO balance
☑ Screenshot of error message
☑ Browser console output (F12 → right-click → Save as)
☑ Transaction hash (if available)
☑ Exact steps you took
```

### 2. Check These Files

- [GAME_TESTING_AND_DEBUGGING.md](GAME_TESTING_AND_DEBUGGING.md) - Full guide with all sections
- [README.md](README.md) - Project overview

### 3. Common Solutions

1. **Reload page:** Ctrl+Shift+R (hard refresh, not Ctrl+R)
2. **Restart backend:** Kill (Ctrl+C) and run `npm run dev:server` again
3. **Clear browser cache:** Settings → Privacy → Clear browsing data
4. **Check balance:** Ensure ≥ 0.002 CELO
5. **Verify network:** MetaMask must show "Celo Testnet"

---

## Checklists by Scenario

### Before First Test Run

- [ ] Node v18+ installed (`node --version`)
- [ ] Dependencies installed (`npm install`)
- [ ] Backend running (`npm run dev:server`)
- [ ] Frontend running (`npm run dev`)
- [ ] Wallet has ≥ 0.002 CELO
- [ ] Browser console open (F12)
- [ ] MetaMask on Celo Testnet

### After First Transaction

- [ ] Console shows success logs
- [ ] Wallet popup appeared
- [ ] Transaction hash visible in logs
- [ ] Block explorer shows "Success"
- [ ] Quest status changed to "ACCEPTED"

### After First Complete Playthrough

- [ ] Generated → Accepted → Submitted → Claimed ✅
- [ ] XP increased
- [ ] NFT in inventory
- [ ] No console errors
- [ ] Wallet balance changed

### After 3 Complete Playthroughs

- [ ] 9 total transactions completed
- [ ] All transactions on block explorer
- [ ] Player level increased
- [ ] 3 NFTs in inventory
- [ ] System stable (no new issues)

---

## Emergency Procedures

### Transaction Stuck (> 2 minutes, not confirmed)

```
1. Check block explorer (see: Block Explorer Verification)
2. If "Pending" → Wait more (Celo is usually < 30 seconds)
3. If "Failed" → See revert reason above
4. If not showing → Try hard refresh (Ctrl+Shift+R)
5. Can safely try again (no duplicate transactions if first failed)
```

### Wallet Keeps Rejecting

```
1. Make sure you're APPROVING (not REJECTING)
2. Check wallet has enough CELO
3. Close MetaMask completely (all windows)
4. Reopen MetaMask, unlock, try again
5. If still fails → Restart browser completely
```

### Page Keeps Showing "Loading"

```
1. Check backend running: npm run dev:server (showing no errors)
2. Check browser console: Any red errors?
3. Hard refresh: Ctrl+Shift+R
4. Restart everything:
   - Kill backend (Ctrl+C)
   - Kill frontend (Ctrl+C)
   - npm run dev:server
   - npm run dev
5. Go back to http://localhost:5173
```

---

## Success! 🎉

When you've completed 3 full playthroughs with no errors, you're done!

**System is working correctly when:**

- ✅ Every transaction succeeds first try
- ✅ No console errors or warnings
- ✅ Wallet popups appear for each transaction
- ✅ Transactions confirm in < 30 seconds
- ✅ Player stats accumulate correctly
- ✅ NFTs appear in inventory
- ✅ Game feels responsive and fast

**Ready for submission!**
