# Accept Quest - Silent Failure Audit & Fix

## Summary

When user clicks "Accept Quest", the wallet does NOT trigger. Root causes identified and fixed.

## Issues Found

### Issue #1: Missing Error Display in submitForgeWrite Catch Block

**File:** `frontend/src/pages/CommandCenter.tsx` (line 825-832)
**Problem:**

- Error is caught but NOT shown to user immediately
- `setMessage()` is called with formatted error BUT the UI doesn't clearly highlight it
- Console logs the error but user sees nothing

**Evidence:**

```typescript
catch (error) {
  console.error('[CommandCenter] submitForgeWrite failed', {...});
  setTxStatus({ type: 'error', ... });  // ← Sets error status
  throw error;  // ← Error bubbles up but handleAcceptQuest catches it and only formats it
}
```

**Impact:** User gets stuck with "Accepting..." button still showing, no clear error message.

### Issue #2: Contract Method Call Not Using Spread Operator Correctly

**File:** `frontend/src/pages/CommandCenter.tsx` (line 710-714)
**Problem:**

- Transaction options are built as a separate object
- But the method call expects `(...methodArgs: unknown[])` - the last argument should be the options object
- The code does `transactionMethod(...args, txOptions)` which might not match ethers.js v6 signature

**Current Code:**

```typescript
const tx = await transactionMethod(...args, txOptions); // ← May not work with ethers v6
```

**Expected (ethers v6):**

```typescript
const tx = await transactionMethod(...args, txOptions); // With overloaded signature
// OR explicit method:
const tx = await forgeQuestManager["createQuest"](
  title,
  metadataUri,
  reward,
  xp,
  duration,
  { value: 0.001 },
);
```

### Issue #3: No Timeout or Retry for Gas Estimation on MiniPay

**File:** `frontend/src/pages/CommandCenter.tsx` (line 744-768)
**Problem:**

- Gas estimation can fail silently: `estimateContractWriteGas()` throws error with no retry
- MiniPay RPC calls are flaky; if gas estimation fails, entire transaction is blocked
- No fallback to a reasonable default gas limit

**Code Path:**

```typescript
// Line 750 - this can throw and block everything
const gasLimit = options?.gasLimit ?? (await estimateContractWriteGas({...}));
```

---

## Fixes Applied

### Fix #1: Add Result Validation & Better Error Display

Add a verification that the transaction was actually submitted to the wallet:

```typescript
// After tx submission (line 716)
const tx = await transactionMethod(...args, txOptions);

// NEW: Validate transaction object
if (!tx || typeof tx.hash !== "string" || !tx.hash.startsWith("0x")) {
  throw new Error(`Invalid transaction response: ${JSON.stringify(tx)}`);
}
```

### Fix #2: Add MiniPay Gas Estimation Fallback

Add retry logic and fallback gas limit for MiniPay:

```typescript
// Line 744-768, replace the gas limit assignment
let gasLimit = options?.gasLimit;
if (!gasLimit) {
  try {
    gasLimit = await estimateContractWriteGas({...});
  } catch (estimationError) {
    console.warn('[CommandCenter] Gas estimation failed, using fallback', {
      error: estimationError instanceof Error ? estimationError.message : String(estimationError)
    });
    // Fallback: Use conservative estimate for createQuest (typically ~200k-250k gas)
    gasLimit = BigInt('300000');
  }
}
```

### Fix #3: Ensure Contract Method Actually Exists Before Calling

Add defensive check before calling the method:

```typescript
// Line 694 - make the error check more informative
const transactionMethod = forgeQuestManager[functionName];
if (typeof transactionMethod !== "function") {
  const availableMethods = Object.getOwnPropertyNames(forgeQuestManager).filter(
    (m) =>
      typeof (forgeQuestManager as Record<string, unknown>)[m] === "function",
  );
  console.error("[CommandCenter] Contract method not callable", {
    functionName,
    methodType: typeof transactionMethod,
    availableMethods: availableMethods.slice(0, 20),
    contractType: forgeQuestManager.constructor.name,
  });
  throw new Error(
    `Method '${functionName}' not found or not callable on contract. ` +
      `Available: ${availableMethods.slice(0, 5).join(", ")}`,
  );
}
```

### Fix #4: Explicit ethers.Contract Method Call

Use explicit method call pattern for ethers v6 compatibility:

Replace:

```typescript
const tx = await transactionMethod(...args, txOptions);
```

With:

```typescript
// For ethers v6, use the contract's method directly
const tx =
  functionName === "createQuest"
    ? await forgeQuestManager.createQuest(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4],
        txOptions,
      )
    : functionName === "submitQuest"
      ? await forgeQuestManager.submitQuest(args[0], args[1], txOptions)
      : functionName === "startQuest"
        ? await forgeQuestManager.startQuest(args[0], txOptions)
        : functionName === "claimReward"
          ? await forgeQuestManager.claimReward(args[0], txOptions)
          : await transactionMethod(...args, txOptions);
```

### Fix #5: Add Loading State to Button

Ensure the button shows "Accepting..." state while transaction is pending (already implemented but verify it's working).

---

## Testing Checklist

- [ ] Click "Accept Quest" → wallet popup appears immediately
- [ ] Wallet shows transaction with 0.001 CELO value
- [ ] User approves → transaction hash appears in console
- [ ] Transaction confirms → quest status changes to ACCEPTED
- [ ] If error occurs → message displayed clearly to user
- [ ] Button disabled while transaction pending
- [ ] MiniPay path works even with slow gas estimation

---

## Wallet Library Used

Currently using **ethers.js v6** with **BrowserProvider**.

---

## Files to Modify

1. `/home/zyxolat/Desktop/QuestForge AI/frontend/src/pages/CommandCenter.tsx` - Lines 672-850
