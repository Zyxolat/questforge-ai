# Quest Registration Architecture Review

**Date**: June 11, 2026  
**Implementation**: Auto-registration of quests immediately after database save  
**Status**: OPERATIONAL - but recommend MODIFICATION

---

## Executive Summary

The current auto-registration implementation is **functionally correct but architecturally inefficient** at scale. It trades gas cost for simplicity. Recommendation: **MODIFY** to implement lazy-registration with cost controls via game mechanics.

---

## 1. Does this match the Online ForgeQuest gameplay model?

**Answer**: PARTIALLY, with centralization concerns

### Current Flow

```
Player generates quest (client asks backend)
  ↓
Backend saves to database
  ↓
Backend (using VERIFIER_PRIVATE_KEY) calls createQuest()
  ↓
Quest becomes available on-chain
  ↓
Player accepts (if desired)
```

### Issue: **Admin/Centralized Operation**

- Only the backend can create quests on-chain (via `verifierSigner`)
- Individual players have **no direct on-chain action** during quest generation
- This contradicts "decentralized peer-to-peer" game design
- Players cannot prove they created a quest (backend did)

### Assessment

✗ **Not aligned with decentralized gameplay** - players should have agency in on-chain actions  
✓ **Aligned with service-based model** - if you're positioning this as a game service (like Fortnite), this is fine

---

## 2. Will every generated quest create an on-chain transaction?

**Answer**: YES - every single quest generation triggers one `createQuest()` transaction

### Current Implementation

```typescript
// questController.ts line 308-340
const registrationPromise = (async () => {
  const result = await registerQuestOnchain({...});
  // This ALWAYS runs for every generated quest
})();
```

### Evidence from Smart Contract

```solidity
// ForgeQuestManager.sol line 136
function createQuest(...) external payable {
  uint256 questId = nextQuestId;
  nextQuestId += 1;  // ← Creates new on-chain record
  quests[questId] = Quest({...});
  emit QuestCreated(questId, msg.sender, title, ...);
}
```

### Cost Breakdown (Celo Mainnet)

- **Gas per createQuest()**: ~150,000-200,000 gas units
- **Celo gas price**: ~0.5-1 gwei (varies)
- **Cost per quest**: ~0.075-0.2 CELO (~$0.0375-$0.10)
- **Annual cost at 100 quests/day**: $1,370-$3,650
- **Annual cost at 1,000 quests/day**: $13,700-$36,500

### Fire-and-Forget Timing

```typescript
// questController.ts line 340
registrationPromise.catch((err) => {
  logger.error('[QUEST] Auto-registration promise rejection', {...});
});
// ← Returns to user immediately, doesn't wait
```

✓ **Non-blocking**: API returns before on-chain registration completes  
✗ **No confirmation**: User doesn't know if on-chain registration succeeded

---

## 3. What happens if 10,000 quests are generated but only 100 are accepted?

**Answer**: 9,900 wasted on-chain transactions

### Scenario Analysis

```
10,000 quests generated in database
  ↓
10,000 createQuest() transactions submitted to blockchain
  ↓
~9,900 of them NEVER have acceptQuest() called
  ↓
Chain is polluted with unused quest records
Block space wasted
Gas paid for unused quests
```

### Cost Impact

- **Gas spent**: 9,900 × ~175,000 gas = 1,732,500,000 gas
- **Cost**: 1,732,500,000 × 1 gwei = ~1,732.5 CELO (~$866)
- **Utilization rate**: 1% (only 100 of 10,000 are used)

### Real-World Scenario

In a mobile-first game (Celo ecosystem):

- Users might test/spam quest generation
- Alt accounts might generate quests for experimentation
- Quests with poor rewards might go unaccepted
- Acceptance rate could realistically be 10-30%, not 1%

### Comparison: Lazy-Registration Model

```
10,000 quests in database (cost: $0)
  ↓
100 players accept quests
  ↓
100 createQuest() + 100 acceptQuest() transactions only
  ↓
Gas cost: only for accepted quests
Cost: 100 × $0.10 = $10 (not $866)
Efficiency: 99.9% (only pay for what's used)
```

---

## 4. Who pays gas for auto-registration?

**Answer**: **The game operator (backend server)**

### Evidence

```typescript
// contracts.ts
const verifierSigner = env.VERIFIER_PRIVATE_KEY
  ? new ethers.Wallet(env.VERIFIER_PRIVATE_KEY, provider)
  : null;

// questRegistration.ts
const tx = await contracts.forgeQuestManagerWrite.createQuest(...)
// forgeQuestManagerWrite is connected to verifierSigner
```

### Cost Model

- **Game operator wallet**: Pays all gas
- **Player wallet**: Pays 0 CELO for quest generation, 0.001 CELO for acceptance only
- **Treasury wallet**: Receives acceptance fees (optional revenue)

### Implication

✓ **Low barrier to entry** - players don't need CELO balance to generate quests  
✗ **Operator cost burden** - all generation costs hit the game budget  
✗ **Spam risk** - no financial friction to prevent spam generation

---

## 5. Is `createQuest()` now effectively an admin operation?

**Answer**: YES - effectively admin-only

### Why

```solidity
function createQuest(...) external payable { ... }
// "external" = anyone can call it

// BUT in practice:
// - Player calls: backend.generateQuest() → API
// - Backend calls: contract.createQuest() using verifierSigner
// - Player cannot directly call contract.createQuest()
```

### Analysis

- Players don't sign the quest creation transaction
- Players don't own the creation on-chain
- Backend is the admin/gatekeeper
- **Centralization point**: If backend is hacked, attacker can create quests

### Decentralization Implications

- ✗ Not true peer-to-peer (backend intermediates)
- ✗ Players have no cryptographic proof of quest ownership
- ✓ But fine for a service-based game (like most web3 games)

### Comparison: Decentralized Model

```
// Decentralized: Player signs directly
Player calls: contract.createQuest() with own private key
  ↓
Player pays gas themselves
  ↓
Quest ownership is cryptographically proven

// Current: Centralized intermediary
Player calls: API backend.generateQuest()
  ↓
Backend calls: contract.createQuest() with VERIFIER_PRIVATE_KEY
  ↓
Backend pays gas, backend controls on-chain action
```

---

## 6. Is there a cheaper architecture for lazy-registration?

**Answer**: YES - defer to acceptance time

### Architecture Option 2: Lazy-Registration

```
GENERATE QUEST
  ↓
Save to database only (cost: $0)
Store quest metadata, chainQuestId = NULL
  ↓
ACCEPT QUEST
  ↓
Backend detects chainQuestId is NULL
Backend calls: createQuest() + acceptQuest() in sequence
  ↓
Store chainQuestId after first acceptQuest() succeeds
  ↓
Cost: only for accepted quests
```

### Cost Comparison

| Metric                                 | Auto-Registration  | Lazy-Registration    |
| -------------------------------------- | ------------------ | -------------------- |
| Gas per generated quest                | Yes (150-200k gas) | No                   |
| Gas per accepted quest                 | 0 (already paid)   | Yes (~150-200k gas)  |
| Utilization efficiency                 | 1-30% (wasteful)   | 100% (only accepted) |
| Annual cost (100/day gen, 30% accept)  | ~$11,000           | ~$1,095              |
| Annual cost (1000/day gen, 30% accept) | ~$110,000          | ~$10,950             |
| **Savings**                            | —                  | **~90%**             |

### Implementation Complexity

**Current (Auto-Registration)**

```typescript
generateQuest() {
  saveToDb();
  registerQuestOnchain(); // fire-and-forget
  return {questId, status: AVAILABLE};
}
```

✓ Simple - no coordination needed  
✓ No race conditions - each quest has unique chainQuestId  
✗ Wasteful - pays for unaccepted quests

**Lazy-Registration**

```typescript
generateQuest() {
  saveToDb();
  return {questId, status: AVAILABLE, chainQuestId: null};
}

acceptQuest(questId) {
  if (!quest.chainQuestId) {
    // First-time acceptance: register on-chain
    const chainQuestId = await createQuestOnchain();
    await updateDb({chainQuestId});
  }
  // Then accept
  await acceptQuestOnchain(chainQuestId);
}
```

**Race Condition Risk**: If two players accept the same quest simultaneously

```
Player A: IF chainQuestId NULL → createQuest() → acceptQuest()
Player B: IF chainQuestId NULL → createQuest() → acceptQuest()
Result: TWO createQuest() calls, duplicate on-chain quests
```

**Solutions**:

1. **Database lock** during lazy-registration
2. **New smart contract function**: `createAndAcceptQuest()` atomic operation
3. **Accept only first player** - second player fails

---

## 7. Does auto-registration introduce risks?

### A. **Gas Costs** ✗ HIGH RISK

- **Problem**: Scales linearly with generated quests
- **Example**: 1,000 quests/day = $100-300/day = $36.5K-109.5K/year
- **Mitigation**: Rate limiting (already implemented), quest generation costs

### B. **Spam Risk** ✗ MEDIUM RISK

- **Problem**: No on-chain cost to generate quests
- **Attack**: Bot generates 10,000 quests with no cost
- **Impact**: Chain bloat, high gas spending
- **Mitigation**:
  - ✓ Rate limiting exists
  - ✓ Daily limits exist
  - ✗ No reputation/level requirement
  - ✗ No quest generation fee

### C. **Scalability Issues** ✗ HIGH RISK

- **Problem**: 1 quest generated = 1 blockchain transaction
- **Bottleneck**: Celo block time ~5 seconds
- **Capacity**: ~1 transaction per 5 seconds = ~17,280 quests/day max
- **Issue**: If game goes viral, you hit the blockchain TPS limit

### D. **Duplicate Quest Risk** ✓ LOW RISK (Current)

- **Problem**: None - each auto-registration gets unique questId
- **Mitigation**: `nextQuestId` counter in smart contract prevents duplicates
- **Status**: SAFE

### E. **Centralization Risk** ✗ MEDIUM RISK

- **Problem**: Backend controls all on-chain quest creation
- **Attack**: Compromise VERIFIER_PRIVATE_KEY → attacker can create quests
- **Mitigation**:
  - Use hardware wallet for verifierSigner (not software key in .env)
  - Regular key rotation
  - Limit backend wallet to CELO only, no other assets
  - Audit transaction patterns for anomalies

---

## 8. Does current implementation reintroduce centralization?

**Answer**: YES - significantly

### Centralization Points

| Component           | Decentralization           | Risk |
| ------------------- | -------------------------- | ---- |
| Quest creation      | Backend intermediates      | HIGH |
| Quest acceptance    | Direct (user signature)    | LOW  |
| Reward distribution | Smart contract (automatic) | LOW  |
| Reputation system   | Smart contract (automated) | LOW  |

### Current Architecture Flow

```
User (web3 wallet)
  ↓ (calls HTTP API)
Backend (trusted intermediary) ← CENTRALIZATION POINT
  ↓ (signs with VERIFIER_PRIVATE_KEY)
Smart Contract (trustless)
```

### Risks

1. **Backend outage** → players can't generate quests
2. **Backend compromise** → attacker creates fraudulent quests
3. **Backend rug pull** → could redirect funds with signer key
4. **Single point of failure** → one database/key controls quests

### Comparison: Decentralized Alternative

```
User (web3 wallet)
  ↓ (signs directly with own private key)
Smart Contract (trustless, no intermediary)
```

**Problem**: Users would need gas balance for quest generation - bad UX for Celo/MiniPay ecosystem

---

## Recommendation: MODIFY Auto-Registration

### Keep Auto-Registration, But Add Cost Controls

**Rationale**:

- Auto-registration is correct and safe (no race conditions)
- The problem isn't auto-registration itself, it's **unbounded usage**
- Add game mechanics to prevent spam, not infrastructure changes

### Proposed Changes

#### 1. **Implement Quest Generation Costs** (CRITICAL)

```typescript
// questController.ts
async function generateQuest(req, res) {
  const user = await getUser(req.auth.userId);

  // Check daily quest limit
  const dailyCount = await getDailyQuestCount(user.id);
  if (dailyCount >= DAILY_LIMIT[user.level]) {
    return res.status(429).json({ error: "Daily quest limit reached" });
  }

  // Check reputation requirements
  if (user.reputation.level < MIN_LEVEL_TO_GENERATE) {
    return res
      .status(403)
      .json({ error: "Insufficient level to generate quests" });
  }

  // Charge XP fee (or CELO if funded)
  const generationCost = calculateGenerationCost(user);
  if (user.xp < generationCost) {
    return res
      .status(402)
      .json({ error: "Insufficient XP for quest generation" });
  }

  user.xp -= generationCost;

  // Now generate quest...
}
```

#### 2. **Implement Reputation/Level Requirements**

```
Level 1-5: Can generate 5 quests/day
Level 6-10: Can generate 20 quests/day
Level 11+: Can generate 100 quests/day
```

#### 3. **Monitor Gas Spending**

```typescript
// Log auto-registration costs
logger.info("[MONITOR] Auto-registration completed", {
  questId,
  txHash,
  gasUsed,
  gasPrice,
  costCELO: estimatedCost,
  monthlySpend: getMonthlyAutoRegistrationCost(),
});
```

#### 4. **Add Circuit Breaker**

```typescript
// If monthly gas cost exceeds budget, pause auto-registration
if (getMonthlyAutoRegistrationCost() > MONTHLY_GAS_BUDGET) {
  logger.error("[CIRCUIT] Auto-registration cost limit exceeded");
  // Fallback to lazy-registration for remaining quests
}
```

### Implementation Timeline

**Phase 1 (This Week)**

- ✓ Auto-registration implemented (DONE)
- Add monitoring/logging of gas costs
- Implement daily quest generation limits (increase from current)

**Phase 2 (Next Week)**

- Implement reputation level requirements
- Implement XP-based generation costs
- A/B test cost parameters

**Phase 3 (Future)**

- If cost metrics show >$50K/month and <20% acceptance rate
- Switch to lazy-registration model
- Requires smart contract change: add `createAndAcceptQuest()` function

---

## Final Recommendation: **KEEP + MODIFY**

### Decision Matrix

| Factor                | Decision     | Reasoning                                               |
| --------------------- | ------------ | ------------------------------------------------------- |
| **Core Architecture** | ✓ KEEP       | No race conditions, simple, correct                     |
| **Cost Control**      | ⚠ MODIFY     | Add daily limits + reputation requirements + XP costs   |
| **Centralization**    | ✓ ACCEPTABLE | Fine for service-based game, not peer-to-peer           |
| **Scalability**       | ⚠ MONITOR    | Add metrics, plan Phase 3 migration if needed           |
| **Spam Prevention**   | ⚠ MODIFY     | Current rate limiting insufficient, need game mechanics |

### Action Items

1. **CRITICAL**: Add quest generation costs/limits (prevent spam)
2. **HIGH**: Add monitoring dashboard for auto-registration costs
3. **HIGH**: Implement daily quest generation limits per player
4. **MEDIUM**: Document centralization trade-off in architecture guide
5. **MEDIUM**: Plan Phase 3 lazy-registration if metrics warrant it
6. **LOW**: Harden verifierSigner (use hardware wallet in production)

### Success Criteria

- Auto-registration succeeds >99% of the time
- Monthly gas cost stays <$2,000
- Quest acceptance rate >15% (adjusted for game design)
- No spam/abuse detected in quest generation
- Player UX: generate quest = instant confirmation

---

## Appendix: Smart Contract Design Review

### Current Design: Separate `createQuest()` and `acceptQuest()`

```solidity
createQuest(title, metadataUri, reward, xp, duration)
  → Generates unique questId
  → Reserves reward in Treasury
  → Status = AVAILABLE

acceptQuest(questId)
  → Requires 0.001 CELO
  → Checks questId exists and status == AVAILABLE
  → Sets player, status = ACCEPTED
```

**Assessment**: ✓ GOOD DESIGN

- Clear separation of concerns
- Enables lazy-registration path if needed
- Prevents acceptance of non-existent quests

### Alternative Design: Atomic Operation (Future)

```solidity
createAndAcceptQuest(title, metadataUri, reward, xp, duration)
  → ATOMIC: create + accept in single call
  → Prevents duplicate quests from race conditions
  → Enables true lazy-registration
```

**Trade-off**: Requires smart contract upgrade, might break existing quest references
