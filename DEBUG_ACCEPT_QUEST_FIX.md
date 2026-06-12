# 🔴 ACCEPT QUEST NOT WORKING - ROOT CAUSE & FIX

**Status**: CRITICAL - Deploy blocking  
**Issue**: Contract address mismatch between deployed contract and frontend/backend config  
**Severity**: HIGH  
**Estimated Fix Time**: 10-15 minutes

---

## 📋 PROBLEM SUMMARY

Your "Accept Quest" button fails because:

1. ✅ New ForgeQuestManager deployed to mainnet: `0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A`
2. ❌ Frontend still pointing to OLD address: `0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2`
3. ❌ Backend may also be using OLD address
4. Result: Browser calls function on wrong contract → Error

---

## 🔍 EVIDENCE

### Current Configuration

| File            | Variable                           | Current Value                                            | Should Be                                       |
| --------------- | ---------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| `frontend/.env` | `VITE_FORGE_QUEST_MANAGER_ADDRESS` | `0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2` ❌          | `0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A` ✅ |
| `backend/.env`  | `FORGE_QUEST_MANAGER_ADDRESS`      | `0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e` (local dev) | `0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A` ✅ |
| Railway         | `FORGE_QUEST_MANAGER_ADDRESS`      | UNKNOWN                                                  | `0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A` ✅ |
| Vercel          | `VITE_FORGE_QUEST_MANAGER_ADDRESS` | UNKNOWN (but likely OLD)                                 | `0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A` ✅ |

---

## ✅ STEP-BY-STEP FIX

### FIX #1: Update Frontend Local Config (For Local Testing)

**File**: [frontend/.env](frontend/.env)

Change this:

```env
VITE_FORGE_QUEST_MANAGER_ADDRESS=0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2
```

To this:

```env
VITE_FORGE_QUEST_MANAGER_ADDRESS=0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A
```

### FIX #2: Update Vercel Production Config (CRITICAL)

**Steps**:

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your project: `questforge-ai-chi`
3. Navigate to: **Settings** → **Environment Variables**
4. Find the variable: `VITE_FORGE_QUEST_MANAGER_ADDRESS`
5. Click **Edit** and change the value:
   - **From**: `0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2`
   - **To**: `0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A`
6. Click **Save**
7. Trigger a **Redeploy**:
   - Go to **Deployments** tab
   - Click the **3-dot menu** on the latest deployment
   - Select **Redeploy**
   - Wait 2-3 minutes for deployment to complete

**How to verify**:

- After deployment completes, go to [questforge-ai-chi.vercel.app](https://questforge-ai-chi.vercel.app)
- Open browser console (F12 → Console)
- Run:
  ```javascript
  console.log(import.meta.env.VITE_FORGE_QUEST_MANAGER_ADDRESS);
  ```
- Should display: `0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A`

---

### FIX #3: Update Railway Backend Config (CRITICAL)

**Steps**:

1. Go to [Railway Dashboard](https://railway.app)
2. Select your `questforge-ai` project
3. Click the **Backend** service
4. Go to **Variables** tab
5. Find: `FORGE_QUEST_MANAGER_ADDRESS`
6. Click **Edit** and change the value:
   - **From**: `0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2` (or whatever old value is there)
   - **To**: `0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A`
7. Click **Save**
8. Wait for auto-redeploy (should take 2-3 minutes)
9. Check **Deployments** tab to verify the new deployment is active

**How to verify**:

- Call your backend health check endpoint:
  ```bash
  curl https://questforge-ai-production.up.railway.app/api/health
  ```
- Should return 200 OK with service details

---

### FIX #4: Update Backend Local Dev Config

**File**: [backend/.env](backend/.env) (for local testing only)

Change this:

```env
FORGE_QUEST_MANAGER_ADDRESS=0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e
```

To this:

```env
FORGE_QUEST_MANAGER_ADDRESS=0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A
```

---

## 🧪 TESTING AFTER FIXES

### Test 1: Browser Console Check

```javascript
// Run in browser console at questforge-ai-chi.vercel.app
console.log(
  "Contract Address:",
  import.meta.env.VITE_FORGE_QUEST_MANAGER_ADDRESS,
);
// Expected: 0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A
```

### Test 2: Click Accept Quest

1. Go to [questforge-ai-chi.vercel.app](https://questforge-ai-chi.vercel.app)
2. Connect MetaMask to **CELO Mainnet** (Chain ID: 42220)
3. Accept a quest
4. **Should NOT see errors** in browser console about contract address

### Test 3: Check Network Request

1. Open F12 → **Network** tab
2. Click "Accept Quest"
3. Look for requests:
   - Should go to `/api/quests/accept` (backend)
   - Should NOT show 404 or 500 errors
   - Should show 200 OK

### Test 4: Verify Contract on CeloScan

Check [https://celoscan.io/address/0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A](https://celoscan.io/address/0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A):

- Click **Contract** tab
- Look for `createAndAcceptQuest` or `acceptQuest` in the contract functions
- Should be present in the ABI

---

## 📊 COMPARISON: OLD vs NEW

| Aspect    | Old Contract                                 | New Contract                                 |
| --------- | -------------------------------------------- | -------------------------------------------- |
| Address   | `0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2` | `0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A` |
| Network   | CELO Mainnet                                 | CELO Mainnet                                 |
| Status    | OUTDATED                                     | ACTIVE ✅                                    |
| Functions | May not have latest                          | Has createAndAcceptQuest ✅                  |

---

## ⚠️ COMMON MISTAKES TO AVOID

- ❌ **Don't forget to redeploy** after updating Vercel env vars
- ❌ **Don't copy-paste old address** by mistake
- ❌ **Don't forget trailing zeros** in the address
- ❌ **Don't use testnet address** on mainnet (case sensitivity matters)

---

## 🔗 USEFUL LINKS

- [CeloScan - New Contract](https://celoscan.io/address/0x29A20865E9972dA5F1956Fd6B05a4cA744C1A11A)
- [CeloScan - Old Contract](https://celoscan.io/address/0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2)
- [Vercel Dashboard](https://vercel.com/dashboard)
- [Railway Dashboard](https://railway.app)

---

## 📝 DEPLOYMENT CHECKLIST

- [ ] Updated `frontend/.env` with new address
- [ ] Updated Vercel environment variables
- [ ] Redeployed Vercel frontend
- [ ] Verified Vercel deployment is active
- [ ] Updated Railway backend environment variables
- [ ] Verified Railway backend redeploy is complete
- [ ] Tested "Accept Quest" button in browser
- [ ] Confirmed no errors in browser console
- [ ] Verified CeloScan shows contract has function

---

## 🚀 EXPECTED OUTCOME

After applying all fixes:

1. ✅ "Accept Quest" button will be clickable
2. ✅ MetaMask will show transaction proposal
3. ✅ No "contract address mismatch" errors
4. ✅ Backend will process the acceptance
5. ✅ Player will receive quest acceptance confirmation

---

## 🆘 IF STILL NOT WORKING

If "Accept Quest" still fails after these fixes, provide:

1. **Browser Console Errors** (F12 → Console):

   ```javascript
   // Paste entire error message
   ```

2. **Network Errors** (F12 → Network):
   - Screenshot of failed request
   - Response details

3. **Verification**:

   ```javascript
   console.log(import.meta.env.VITE_FORGE_QUEST_MANAGER_ADDRESS);
   console.log(import.meta.env.VITE_CELO_RPC_URL);
   ```

4. **MetaMask Info**:
   - Are you on CELO Mainnet (Chain ID: 42220)?
   - Wallet balance > 0.01 CELO?
   - Account is connected to the app?

---

**Created**: 2026-06-12  
**Last Updated**: 2026-06-12
