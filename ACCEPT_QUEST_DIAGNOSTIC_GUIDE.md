# Accept Quest Wallet Trigger - Diagnostic Guide

## Problem Statement

"When user clicks 'Accept Quest', nothing happens — wallet does not trigger, no transaction is initiated, game stops there"

## Diagnostic Steps

### Step 1: Verify Button Click is Registering

1. Open browser DevTools (F12)
2. Go to Console tab
3. Click "Accept Quest" button
4. **Look for these console messages:**
   - `[handleAcceptQuest] Button clicked - starting accept quest flow`
   - If you see this, the click handler IS being called
   - If you DON'T see this, the button click isn't being registered

### Step 2: Check Early Validation Failures

If you see the first message, look for:

```
[handleAcceptQuest] Early exit - reason:
```

This will show WHY the function exited early. Possible reasons:

- `NO_WALLET_ADDRESS` - Wallet not connected (but you should see "Connect Wallet" if this is the case)
- `NO_CONTRACT` - ForgeQuestManager contract not initialized
- `NO_QUEST` - No quest was generated

If you see any of these, the wallet popup won't appear because the function exits before reaching the contract call.

### Step 3: Check Authentication Status

Look for this message:

```
[handleAcceptQuest] Pre-auth validation passed, checking authentication...
```

If you see this, then:

- Wallet is connected ✓
- Contract exists ✓
- Quest exists ✓

Then look for:

```
[handleAcceptQuest] Authentication passed, proceeding with transaction
```

If you see this, then authentication also passed. If you DON'T see this, the authentication failed.

### Step 4: Check Contract Method Call

Look for:

```
[CommandCenter] handleAcceptQuest: Calling submitForgeWrite
```

If you see this, we're about to call the contract method. This is where the wallet popup SHOULD appear.

If you DON'T see this, there's an error between authentication and the contract call. Check for error messages like:

```
[CommandCenter] submitForgeWrite failed
```

### Step 5: Read the Complete Error Chain

If an error occurred, look for:

```
[CommandCenter] submitForgeWrite failed' with:
- errorName: [name of error]
- errorMessage: [description]
- isMiniPay: [true/false]
- hasForgeQuestManager: [true/false]
- hasSigner: [true/false]
- hasProvider: [true/false]
```

This will tell you exactly what went wrong.

## Most Likely Issues

### Issue A: Contract Method Not Found

**Error message you'd see:**

```
"Method 'createQuest' not found on ForgeQuestManager contract"
```

**Cause:** The contract ABI might not have been loaded correctly, or the contract address is wrong

**Check:**

- Look for `[CommandCenter] ForgeQuestManager contract initialized` in console
- It should show: `hasCreateQuestMethod: true`
- If it shows `false`, the ABI is missing the createQuest function

### Issue B: No Signer Available

**Error message you'd see:**

```
"Wallet signer is unavailable"
```

**Cause:** Wallet is connected but the signer wasn't properly extracted

**Check:**

- Look for `[CommandCenter] Using standard wallet path` in console
- If you see `signerType: JsonRpcSigner`, it's working
- If you don't see this message, the wallet provider isn't set up correctly

### Issue C: MiniPay Specific Issue

**If using MiniPay:**

- Look for `[CommandCenter] Sending MiniPay transaction`
- If you see `[CommandCenter] Gas estimation failed, using fallback`, gas estimation is problematic
- Check browser console for any MiniPay-specific errors

### Issue D: Wrong Network

**Error message you'd see:**

```
"Switch to Celo before accepting quest"
```

**Cause:** Not connected to Celo network (either mainnet or testnet)

**Check:**

- Look for `isCorrectNetwork: false` in any message
- Make sure MetaMask is set to Celo network (chainId: 42220)

## Recovery Steps

If you find the issue from above:

### For Contract Method Issues:

1. Clear browser cache (Ctrl+Shift+Delete)
2. Hard reload page (Ctrl+Shift+R)
3. Reconnect wallet

### For Signer Issues:

1. Check if MetaMask is properly connected to the site
2. In MetaMask, click the account icon and ensure "Connected" status is shown
3. Try disconnecting and reconnecting the wallet

### For Network Issues:

1. In MetaMask, switch to Celo Mainnet (or Celo Alfajores testnet)
2. If the network isn't available, add it manually:
   - Network Name: Celo
   - RPC URL: https://forno.celo.org
   - Chain ID: 42220
   - Currency: CELO

### For MiniPay Issues:

1. Make sure you have test CELO in your MiniPay wallet
2. Try with a smaller transaction first
3. Check if the gas limit fallback is being used (300000 for createQuest)

## Testing Checklist

Before saying the fix works, verify ALL of these:

- [ ] Click "Accept Quest" button
- [ ] See wallet popup/modal appear
- [ ] Approve transaction in wallet
- [ ] See message: "Celo confirmed the transaction"
- [ ] Quest status changes to "ACTIVE"
- [ ] Can submit proof for the quest
- [ ] Repeat 2 more times successfully

## Console Log Summary Format

Successful flow should show these messages in order:

```
[handleAcceptQuest] Button clicked - starting accept quest flow
[handleAcceptQuest] Quest check: {...}
[handleAcceptQuest] Wallet check: {...}
[handleAcceptQuest] Pre-auth validation passed, checking authentication...
[handleAcceptQuest] Authentication passed, proceeding with transaction
[CommandCenter] handleAcceptQuest: Calling submitForgeWrite
[CommandCenter] submitForgeWrite initiated
[CommandCenter] Using standard wallet path (or "Sending MiniPay transaction" for MiniPay)
[CommandCenter] Calling contract method
[CommandCenter] Transaction sent
[CommandCenter] Transaction confirmed
[CommandCenter] handleAcceptQuest: Transaction receipt received
```

If any of these messages are missing, note which one and look above for the error.
