# LAZY REGISTRATION IMPLEMENTATION CODE

## Ready-to-Deploy Code Snippets

---

## 1. SMART CONTRACT - createAndAcceptQuest() Function

**File**: `contracts/contracts/ForgeQuestManager.sol`  
**Insert After**: Line 206 (after `acceptQuest()` function closes)

```solidity
    /**
     * Atomic operation: Create and immediately accept a quest in a single transaction
     *
     * This function is called by player wallets (not backend) when accepting a quest.
     * It creates a new quest and immediately marks it as accepted by the caller.
     *
     * Requirements:
     * - msg.value == ACCEPTANCE_FEE (0.001 CELO)
     * - All quest parameters must be valid (same as createQuest)
     *
     * Returns: The questId assigned to the newly created quest
     *
     * Events:
     * - QuestCreated(questId, msg.sender, title, rewardAmount, xpReward)
     * - QuestAccepted(questId, msg.sender, block.timestamp)
     */
    function createAndAcceptQuest(
        string calldata title,
        string calldata metadataUri,
        uint256 rewardAmount,
        uint256 xpReward,
        uint256 durationSeconds
    ) external payable whenNotPaused rewardSystemActive nonReentrant
        returns (uint256 questId) {

        // ===== CREATE PHASE =====

        // Validate acceptance fee is paid upfront
        require(msg.value == ACCEPTANCE_FEE, "Accept fee required");

        // Validate quest parameters (identical to createQuest())
        require(bytes(title).length > 0, "Title required");
        require(bytes(metadataUri).length > 0, "Metadata required");
        require(rewardAmount > 0, "Reward required");
        require(rewardAmount <= MAX_SINGLE_REWARD, "Reward exceeds maximum");
        require(xpReward > 0, "XP reward required");
        require(durationSeconds > 0, "Duration required");
        require(durationSeconds <= MAX_QUEST_DURATION, "Duration too long");

        // Allocate new quest ID
        questId = nextQuestId;
        nextQuestId += 1;

        // Reserve reward in treasury (before creating quest)
        ITreasury(treasury).reserveReward(questId, msg.sender, rewardAmount);

        // Create quest structure in Available status
        quests[questId] = Quest({
            questId: questId,
            creator: msg.sender,
            title: title,
            metadataUri: metadataUri,
            proofUri: "",
            proofHash: bytes32(0),
            stakeAmount: 0,
            rewardAmount: rewardAmount,
            xpReward: xpReward,
            createdAt: block.timestamp,
            startedAt: 0,           // Will be set during acceptance
            expiresAt: block.timestamp + durationSeconds,
            status: QuestStatus.Available,
            player: address(0),     // Will be set during acceptance
            playerNonce: 0,
            proofVerificationHash: bytes32(0)
        });

        // Register player quest index and initialize reputation
        playerQuestIndices[msg.sender].push(questId);
        reputation.initializePlayer(msg.sender);

        // Emit quest creation event
        emit QuestCreated(questId, msg.sender, title, rewardAmount, xpReward);

        // ===== ACCEPT PHASE =====

        // Transfer acceptance fee to treasury
        (bool success, ) = payable(treasury).call{value: msg.value}("");
        require(success, "Fee transfer failed");

        // Get player nonce for verification
        uint256 playerNonce = playerNonces[msg.sender];
        playerNonces[msg.sender] = playerNonce + 1;

        // Update quest status to ACCEPTED
        quests[questId].player = msg.sender;
        quests[questId].status = QuestStatus.Accepted;
        quests[questId].startedAt = block.timestamp;
        quests[questId].playerNonce = playerNonce;

        // Emit quest acceptance event
        emit QuestAccepted(questId, msg.sender, block.timestamp);

        return questId;
    }
```

---

## 2. BACKEND - generateQuest() CHANGES

**File**: `backend/src/controllers/questController.ts`

### 2a. REMOVE Import (Line 19)

**DELETE**:

```typescript
import { registerQuestOnchain } from "../services/questRegistration";
```

### 2b. REMOVE Auto-Registration Block (Lines 308-340)

**DELETE THIS ENTIRE BLOCK** (lines 308-340 in current file):

```typescript
// Auto-register the quest on-chain (asynchronously, non-blocking)
const questForRegistration = generated.quest;
const registrationPromise = (async () => {
  try {
    const result = await registerQuestOnchain({
      questId: questForRegistration.id,
      title: questForRegistration.title,
      metadataUri:
        questForRegistration.metadataUri || "data:application/json;base64,e30=",
      rewardAmount: BigInt(
        Math.floor(questForRegistration.rewardAmount * 10 ** 18),
      ),
      xpReward: BigInt(questForRegistration.xpReward),
      durationSeconds: BigInt(questForRegistration.durationSeconds || 3600),
    });

    if (result.success) {
      logger.info("[QUEST] Auto-registration succeeded", {
        questId: questForRegistration.id,
        chainQuestId: result.chainQuestId?.toString(),
        txHash: result.txHash,
      });
    } else {
      logger.warn("[QUEST] Auto-registration failed", {
        questId: questForRegistration.id,
        error: result.error,
      });
    }
  } catch (registrationError) {
    logger.error("[QUEST] Auto-registration error", {
      questId: questForRegistration.id,
      error:
        registrationError instanceof Error
          ? registrationError.message
          : String(registrationError),
    });
  }
})();

// Fire-and-forget: don't wait for registration to complete
registrationPromise.catch((err) => {
  logger.error("[QUEST] Auto-registration promise rejection", {
    error: err instanceof Error ? err.message : String(err),
  });
});
```

### 2c. RESULT - generateQuest() should now proceed directly to response

**AFTER deletion**, the code should flow directly from the `prisma.quest.upsert()` (line ~306) to the logging and response (line ~356+):

```typescript
await prisma.quest.upsert({
  where: { id: generated.quest.id },
  create: questPayload,
  update: questUpdate,
});

// ← NO AUTO-REGISTRATION HERE ANYMORE

logger.info("[QUEST] Generate quest request succeeded", {
  wallet,
  userId: user.id,
  questId: generated.quest.id,
  orchestrationId: generated.quest.orchestrationId,
  rewardAmount: generated.quest.rewardAmount,
  provider: generated.quest.generation.provider,
  source: generated.quest.generation.source,
  fallbackReason: generated.quest.generation.fallbackReason,
  latencyMs: generated.quest.generation.latencyMs,
});

res.json({
  success: true,
  source: "rule_based",
  quest: {
    id: generated.quest.id,
    chainQuestId: null, // ← OK: null at generation, assigned at acceptance
    status: "AVAILABLE",
    // ... rest of response
  },
});
```

---

## 3. BACKEND - NEW acceptQuest Endpoint

**File**: `backend/src/controllers/questController.ts`

### 3a. Add New Function (after generateQuest)

**INSERT THIS FUNCTION** after the `generateQuest()` function (around line 420):

```typescript
/**
 * Accept a quest that was created via createAndAcceptQuest()
 * Frontend calls this AFTER user wallet confirms the transaction
 *
 * Updates the database with the chainQuestId returned from on-chain createAndAcceptQuest()
 *
 * Request body: {
 *   chainQuestId: string,           // From QuestCreated event
 *   acceptanceTxHash: string        // From user's wallet tx
 * }
 */
export async function acceptQuestOnchain(req: Request, res: Response) {
  const questId = req.params.questId;
  const { chainQuestId, acceptanceTxHash } = req.body;
  const wallet = req.auth?.wallet;

  if (!questId) {
    return res.status(400).json({
      error: {
        code: "QUEST_ID_REQUIRED",
        message: "Quest ID is required in URL",
      },
    });
  }

  if (!chainQuestId || typeof chainQuestId !== "string") {
    return res.status(400).json({
      error: {
        code: "CHAIN_QUEST_ID_REQUIRED",
        message: "chainQuestId is required and must be a string",
      },
    });
  }

  if (!acceptanceTxHash || typeof acceptanceTxHash !== "string") {
    return res.status(400).json({
      error: {
        code: "TX_HASH_REQUIRED",
        message: "acceptanceTxHash is required and must be a string",
      },
    });
  }

  try {
    // Fetch the quest from database
    const quest = await prisma.quest.findUnique({
      where: { id: questId },
    });

    if (!quest) {
      return res.status(404).json({
        error: {
          code: "QUEST_NOT_FOUND",
          message: `Quest ${questId} not found`,
        },
      });
    }

    // Verify the creator matches the authenticated user
    if (quest.creator !== wallet) {
      logger.warn("[QUEST] Unauthorized acceptance attempt", {
        questId,
        expectedCreator: quest.creator,
        actualWallet: wallet,
      });
      return res.status(403).json({
        error: {
          code: "UNAUTHORIZED",
          message: "You do not have permission to accept this quest",
        },
      });
    }

    // Verify quest is in AVAILABLE status
    if (quest.status !== "AVAILABLE") {
      return res.status(400).json({
        error: {
          code: "QUEST_INVALID_STATUS",
          message: `Quest status is ${quest.status}, expected AVAILABLE`,
        },
      });
    }

    // Verify quest is not already accepted on-chain
    if (quest.chainQuestId !== null) {
      return res.status(400).json({
        error: {
          code: "QUEST_ALREADY_REGISTERED",
          message: "Quest is already registered on-chain",
        },
      });
    }

    // Get or create user
    const user = await upsertUser(wallet);

    // Update quest with chainQuestId and acceptance details
    const updatedQuest = await prisma.quest.update({
      where: { id: questId },
      data: {
        chainQuestId: BigInt(chainQuestId),
        playerId: user.id,
        status: "ACCEPTED",
        startedAt: new Date(),
        stakeTxHash: acceptanceTxHash,
      },
    });

    logger.info("[QUEST] Quest accepted on-chain", {
      questId,
      chainQuestId: chainQuestId.toString(),
      wallet,
      txHash: acceptanceTxHash,
      playerNonce: user.username,
    });

    // Publish realtime event for sync
    try {
      await realtimeEventPublisher.publishQuestAccepted({
        questId,
        chainQuestId: BigInt(chainQuestId),
        player: wallet,
        acceptedAt:
          updatedQuest.startedAt?.toISOString() ?? new Date().toISOString(),
      });
    } catch (eventError) {
      logger.warn("[QUEST] Failed to publish realtime event", {
        questId,
        error:
          eventError instanceof Error ? eventError.message : String(eventError),
      });
      // Don't fail the request if realtime publish fails
    }

    res.json({
      success: true,
      quest: {
        id: updatedQuest.id,
        chainQuestId: updatedQuest.chainQuestId?.toString(),
        status: updatedQuest.status,
        playerId: updatedQuest.playerId,
        startedAt: updatedQuest.startedAt?.toISOString(),
        title: updatedQuest.title,
        description: updatedQuest.description,
        rewardAmount: updatedQuest.rewardAmount,
      },
    });
  } catch (error) {
    logger.error("[QUEST] Accept quest on-chain failed", {
      questId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      error: {
        code: "ACCEPT_QUEST_FAILED",
        message: "Failed to accept quest on-chain",
        details: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
```

### 3b. Register Route

**File**: `backend/src/routes/api.ts`

**ADD THIS LINE** after the POST `/quests/generate` route (around line 55):

```typescript
apiRouter.post("/quests/:questId/accept", requireAuth, acceptQuestOnchain);
```

**Also import the function** at the top of routes/api.ts:

```typescript
import {
  generateQuest,
  acceptQuestOnchain,
} from "../controllers/questController";
```

---

## 4. BACKEND - Update Contract ABI

**File**: `backend/src/services/contracts.ts`

**MODIFY** the ForgeQuestManagerABI array (around line 16) to include the new function:

**FIND THIS**:

```typescript
const ForgeQuestManagerABI = [
  "function createQuest(string title,string metadataUri,uint256 rewardAmount,uint256 xpReward,uint256 durationSeconds) external payable",
  "function acceptQuest(uint256 questId) external payable",
  // ... rest of ABI
];
```

**CHANGE TO**:

```typescript
const ForgeQuestManagerABI = [
  "function createQuest(string title,string metadataUri,uint256 rewardAmount,uint256 xpReward,uint256 durationSeconds) external payable",
  "function acceptQuest(uint256 questId) external payable",
  "function createAndAcceptQuest(string title,string metadataUri,uint256 rewardAmount,uint256 xpReward,uint256 durationSeconds) external payable returns (uint256)",
  // ... rest of ABI
];
```

---

## 5. FRONTEND - UPDATE submitForgeWrite Signature

**File**: `frontend/src/pages/CommandCenter.tsx`

**FIND** the function signature (around line 684):

```typescript
  async function submitForgeWrite(
    functionName: 'createQuest' | 'acceptQuest' | 'submitQuest' | 'claimReward',
    args: unknown[],
    options?: { value?: bigint; gasLimit?: bigint }
  ) {
```

**CHANGE TO**:

```typescript
  async function submitForgeWrite(
    functionName: 'createQuest' | 'acceptQuest' | 'createAndAcceptQuest' | 'submitQuest' | 'claimReward',
    args: unknown[],
    options?: { value?: bigint; gasLimit?: bigint }
  ) {
```

---

## 6. FRONTEND - REPLACE handleAcceptQuest()

**File**: `frontend/src/pages/CommandCenter.tsx`

**FIND** the `handleAcceptQuest()` function (starts around line 1065)

**REPLACE THE ENTIRE FUNCTION** (delete lines 1065-1220, insert this):

```typescript
async function handleAcceptQuest() {
  console.log(
    "[handleAcceptQuest] Button clicked - starting accept quest flow",
  );

  // Run comprehensive validation diagnostics
  validateQuestAcceptancePrerequisites();

  const questToAccept = interactiveQuest ?? lastGeneratedQuest;
  console.log("[handleAcceptQuest] Quest check:", {
    hasInteractiveQuest: !!interactiveQuest,
    hasLastGeneratedQuest: !!lastGeneratedQuest,
    selectedQuest: questToAccept?.id,
    selectedQuestStatus: questToAccept?.status,
  });

  console.log("[handleAcceptQuest] Wallet check:", {
    address,
    hasForgeQuestManager: !!forgeQuestManager,
    hasQuestToAccept: !!questToAccept,
  });

  // If no wallet address is present, attempt to prompt the user to connect first
  if (!address) {
    console.debug(
      "[handleAcceptQuest] No wallet address detected — attempting to prompt wallet connection",
    );
    try {
      await connectWallet();
    } catch (connectError) {
      console.error(
        "[handleAcceptQuest] connectWallet attempt failed",
        connectError,
      );
    }
  }

  if (!address || !forgeQuestManager || !questToAccept) {
    const reason = !address
      ? "NO_WALLET_ADDRESS"
      : !forgeQuestManager
        ? "NO_CONTRACT"
        : "NO_QUEST";
    console.error("[handleAcceptQuest] Early exit - reason:", reason, {
      address,
      forgeQuestManager: !!forgeQuestManager,
      questToAccept: !!questToAccept,
    });
    setMessage("Connect your wallet and generate a quest before accepting.");
    return;
  }

  if (questToAccept.status !== "AVAILABLE") {
    console.warn("[handleAcceptQuest] Quest not available:", {
      status: questToAccept.status,
      expectedStatus: "AVAILABLE",
    });
    setMessage("Only generated quests can be accepted.");
    return;
  }

  console.log(
    "[handleAcceptQuest] Pre-auth validation passed, checking authentication...",
  );
  if (!(await requireReadyAuth("accepting quest"))) {
    console.warn(
      "[handleAcceptQuest] Authentication check failed or user rejected",
    );
    return;
  }

  console.log(
    "[handleAcceptQuest] Authentication passed, proceeding with transaction",
  );

  console.info(
    "[CommandCenter] handleAcceptQuest: Quest validation passed, preparing transaction",
    {
      questId: questToAccept.id,
      questTitle: questToAccept.title,
      rewardAmount: questToAccept.rewardAmount,
      contractAddress: contractAddresses.forgeQuestManagerAddress,
      walletAddress: address,
    },
  );

  setLoading(true);
  setTxStatus(null);
  setProofError(null);
  setMessage(
    "Accepting the quest onchain. Approve a 0.001 CELO transaction to begin.",
  );

  try {
    const template = questToAccept as GeneratedQuestTemplate;

    // MIGRATION SUPPORT: Handle old pre-registered quests (chainQuestId already exists)
    if (template.chainQuestId) {
      console.log(
        "[handleAcceptQuest] Legacy quest detected (pre-registered), using old acceptQuest flow",
      );

      const chainQuestId = BigInt(String(template.chainQuestId));

      const { hash: acceptTxHash, receipt } = await submitForgeWrite(
        "acceptQuest",
        [chainQuestId],
        {
          value: ethers.parseEther("0.001"),
        },
      );

      const parsedLog = parseReceiptEvent(
        receipt,
        {
          contractAddress: contractAddresses.forgeQuestManagerAddress,
          contractInterface: forgeQuestManager.interface,
        },
        "QuestAccepted",
      );

      const acceptedAt = parsedLog?.args?.acceptedAt
        ? Number(parsedLog.args.acceptedAt)
        : Date.now() / 1000;

      const persistedQuest: QuestState = {
        ...template,
        chainQuestId: String(chainQuestId),
        status: "ACCEPTED",
        player: address,
        startedAt: acceptedAt,
      };

      setLastGeneratedQuest(persistedQuest);
      patchQuest(questMatcher(questToAccept), persistedQuest);
      upsertQuest(persistedQuest);
      setRevealQuestModal(false);
      setMessage(
        "Quest accepted! Complete the objective and submit proof below.",
      );
      await syncNow();
      return;
    }

    // ===== NEW LAZY-REGISTRATION FLOW =====

    console.debug(
      "[handleAcceptQuest] Creating and accepting quest in single transaction",
      {
        title: template.title,
        rewardAmount: template.rewardAmount,
        xpReward: template.xpReward,
        durationSeconds: template.durationSeconds || 3600,
      },
    );

    // Call createAndAcceptQuest() with user wallet signature
    // User pays 0.001 CELO acceptance fee
    const { hash: txHash, receipt } = await submitForgeWrite(
      "createAndAcceptQuest",
      [
        template.title,
        template.metadataUri || "data:application/json;base64,e30=",
        ethers.parseEther(String(template.rewardAmount)),
        BigInt(template.xpReward),
        BigInt(template.durationSeconds || 3600),
      ],
      { value: ethers.parseEther("0.001") }, // User pays 0.001 CELO acceptance fee
    );

    console.log("[handleAcceptQuest] createAndAcceptQuest confirmed", {
      txHash,
      blockNumber: receipt?.blockNumber,
      gasUsed: receipt?.gasUsed?.toString(),
    });

    // ===== PARSE EVENTS FROM RECEIPT =====

    if (!receipt) {
      throw new Error("Transaction receipt not available");
    }

    // Parse QuestCreated event to get the questId assigned on-chain
    const createdLog = parseReceiptEvent(
      receipt,
      {
        contractAddress: contractAddresses.forgeQuestManagerAddress,
        contractInterface: forgeQuestManager.interface,
      },
      "QuestCreated",
    );

    if (!createdLog || !createdLog.args) {
      console.error(
        "[handleAcceptQuest] QuestCreated event not found in receipt",
      );
      throw new Error("Failed to parse QuestCreated event from transaction");
    }

    // Extract questId from event args
    // Event: QuestCreated(uint256 indexed questId, address indexed creator, string title, uint256 rewardAmount, uint256 xpReward)
    const chainQuestId = createdLog.args.questId;

    if (!chainQuestId) {
      throw new Error("questId not found in QuestCreated event");
    }

    console.log("[handleAcceptQuest] QuestCreated event parsed", {
      chainQuestId: chainQuestId.toString(),
      creator: createdLog.args.creator,
      title: createdLog.args.title,
    });

    // Parse QuestAccepted event for timestamp
    const acceptedLog = parseReceiptEvent(
      receipt,
      {
        contractAddress: contractAddresses.forgeQuestManagerAddress,
        contractInterface: forgeQuestManager.interface,
      },
      "QuestAccepted",
    );

    const acceptedAt = acceptedLog?.args?.acceptedAt
      ? Number(acceptedLog.args.acceptedAt)
      : Date.now() / 1000;

    console.log("[handleAcceptQuest] QuestAccepted event parsed", {
      chainQuestId: acceptedLog?.args?.questId?.toString(),
      acceptedAt,
    });

    // ===== SYNC DATABASE =====

    setMessage("Updating database with quest acceptance...");

    // Call backend to store chainQuestId
    const authToken = localStorage.getItem("auth_token");
    const syncResponse = await fetch(`/api/quests/${template.id}/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        chainQuestId: chainQuestId.toString(),
        acceptanceTxHash: txHash,
      }),
    });

    if (!syncResponse.ok) {
      const errorData = await syncResponse.json().catch(() => ({}));
      console.error("[handleAcceptQuest] Database sync failed", {
        status: syncResponse.status,
        error: errorData,
      });
      throw new Error(
        `Failed to sync quest acceptance to database: ${errorData.error?.message || "Unknown error"}`,
      );
    }

    const syncResult = await syncResponse.json();
    console.log("[handleAcceptQuest] Database sync succeeded", {
      questId: syncResult.quest.id,
      chainQuestId: syncResult.quest.chainQuestId,
    });

    // ===== UPDATE LOCAL STATE =====

    const persistedQuest: QuestState = {
      ...template,
      chainQuestId: chainQuestId.toString(),
      status: "ACCEPTED",
      player: address,
      startedAt: acceptedAt,
    };

    setLastGeneratedQuest(persistedQuest);
    patchQuest(questMatcher(questToAccept), persistedQuest);
    upsertQuest(persistedQuest);
    setRevealQuestModal(false);

    setMessage(
      "Quest accepted! Payment confirmed. Complete the objective and submit proof below.",
    );

    // Trigger realtime sync
    await syncNow();

    console.info("[handleAcceptQuest] Quest acceptance complete", {
      questId: template.id,
      chainQuestId: chainQuestId.toString(),
      status: "ACCEPTED",
    });
  } catch (error) {
    console.error("[handleAcceptQuest] Failed", {
      questId: questToAccept?.id,
      errorName: error instanceof Error ? error.name : "Unknown",
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });

    const errorMessage = error instanceof Error ? error.message : String(error);

    setMessage(`Quest acceptance failed: ${errorMessage}`);
    setProofError(errorMessage);
  } finally {
    setLoading(false);
  }
}
```

---

## DEPLOYMENT CHECKLIST

### Smart Contract

- [ ] Verify `createAndAcceptQuest()` is marked `external payable`
- [ ] Verify `require(msg.value == ACCEPTANCE_FEE, "Accept fee required")`
- [ ] Verify ACCEPTANCE_FEE is 0.001 CELO (check constant definition)
- [ ] Verify both events emitted: QuestCreated and QuestAccepted
- [ ] Verify function returns questId (uint256)
- [ ] Compile without errors: `npx hardhat compile`
- [ ] Test on local Hardhat network
- [ ] Test on Celo testnet
- [ ] Verify on testnet block explorer

### Backend

- [ ] Remove registerQuestOnchain import from questController.ts
- [ ] Remove auto-registration block (lines 308-340)
- [ ] Verify generateQuest() returns quest with chainQuestId: null
- [ ] Add acceptQuestOnchain() function
- [ ] Register route in api.ts: POST /quests/:questId/accept
- [ ] Update ABI in contracts.ts with createAndAcceptQuest
- [ ] Test endpoint: `npm run dev`
  ```bash
  POST /api/quests/test-quest-id/accept
  { "chainQuestId": "123", "acceptanceTxHash": "0x..." }
  ```
- [ ] Verify database updates with chainQuestId
- [ ] Check logs for quest acceptance events

### Frontend

- [ ] Update submitForgeWrite signature to include 'createAndAcceptQuest'
- [ ] Replace handleAcceptQuest() function
- [ ] Verify gas estimation before sending
- [ ] Test locally with quest generation → acceptance
  - [ ] Generate quest → chainQuestId is null ✓
  - [ ] Click Accept → calls createAndAcceptQuest ✓
  - [ ] Receipt parsed → chainQuestId extracted ✓
  - [ ] Database updated via POST /api/quests/:questId/accept ✓
  - [ ] UI shows "Quest accepted! Payment confirmed." ✓
- [ ] Test migration path (quest with pre-existing chainQuestId)
  - [ ] Old acceptQuest() flow still works ✓
- [ ] Test error handling
  - [ ] No network → show error ✓
  - [ ] Low balance → show error ✓
  - [ ] Invalid quest → show error ✓

### Integration

- [ ] Deploy smart contract to Celo testnet
- [ ] Update FORGE_QUEST_MANAGER_ADDRESS in .env (if address changed)
- [ ] Deploy backend
- [ ] Deploy frontend
- [ ] E2E test:
  1. Generate quest on frontend
  2. Verify DB: chainQuestId is NULL
  3. Click Accept
  4. User wallet opens (MetaMask/MiniPay)
  5. Shows 0.001 CELO payment
  6. User approves
  7. TX broadcasts
  8. Receipt parsed
  9. Backend sync completes
  10. UI updates: "Quest accepted!"
  11. Verify DB: chainQuestId is set
  12. Verify blockchain: quest exists and is ACCEPTED

### Monitoring

- [ ] Track createAndAcceptQuest success rate
- [ ] Monitor gas usage on-chain
- [ ] Alert if acceptance fails > 5% of attempts
- [ ] Log all quest acceptances
- [ ] Verify no orphaned quests (null chainQuestId with ACCEPTED status)

---

## ROLLBACK PLAN (if needed)

If createAndAcceptQuest() has issues:

1. **Pause quest generation**: Set QUEST_CONFIG.MAX_QUESTS_PER_DAY = 0
2. **Revert contract**: Deploy old ForgeQuestManager without createAndAcceptQuest
3. **Revert backend**: Re-enable auto-registration (restore questRegistration.ts calls)
4. **Revert frontend**: Restore old handleAcceptQuest() function
5. **Restore chainQuestIds**: Use admin endpoint to register backlog

Total rollback time: ~1 hour (if only frontend/backend, not smart contract)
