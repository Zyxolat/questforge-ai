# Accept Quest - Exact Code Reference

## Transaction Call Flow (Corrected)

### 1. User Clicks "Accept Quest" Button

**File:** `frontend/src/components/ActiveQuestPanel.tsx` or `QuestRevealModal.tsx`

```typescript
<button onClick={onAcceptQuest} disabled={loading}>
  {loading ? 'Accepting...' : 'Accept Quest'}
</button>
```

### 2. handleAcceptQuest() Handler

**File:** `frontend/src/pages/CommandCenter.tsx` (line 954)

```typescript
async function handleAcceptQuest() {
  // Validation
  if (!address || !forgeQuestManager || !questToAccept) {
    setMessage("Connect your wallet and generate a quest before accepting.");
    return;
  }

  if (questToAccept.status !== "AVAILABLE") {
    setMessage("Only generated quests can be accepted.");
    return;
  }

  // Auth check
  if (!(await requireReadyAuth("accepting quest"))) {
    return;
  }

  setLoading(true);
  setMessage(
    "Accepting the quest onchain. Approve a 0.001 CELO transaction to begin.",
  );

  try {
    const template = questToAccept as GeneratedQuestTemplate;

    // Prepare args for createQuest(title, metadataUri, rewardAmount, xpReward, durationSeconds)
    const createQuestArgs = [
      template.title, // string: quest title
      template.metadataUri, // string: metadata URI
      ethers.parseEther(template.rewardAmount.toString()), // uint256: reward in wei
      BigInt(template.xpReward), // uint256: XP reward
      BigInt(template.durationSeconds), // uint256: duration in seconds
    ] as const;

    // Call submitForgeWrite with 0.001 CELO fee
    const { hash: creationTxHash, receipt } = await submitForgeWrite(
      "createQuest",
      [...createQuestArgs],
      { value: ethers.parseEther("0.001") }, // ← 0.001 CELO in wei
    );

    // Parse QuestCreated event to get chainQuestId
    const parsedLog = parseReceiptEvent(
      receipt,
      {
        contractAddress: contractAddresses.forgeQuestManagerAddress,
        contractInterface: forgeQuestManager.interface,
      },
      "QuestCreated",
    );

    const chainQuestId = parsedLog?.args?.questId?.toString();
    if (!chainQuestId) {
      throw new Error("Quest creation receipt did not include a quest id");
    }

    // Sync with backend
    const registeredQuest = await registerOnchainQuestWithRetry(
      String(template.id),
      chainQuestId,
      creationTxHash,
    );

    // Update local state
    const persistedQuest: QuestState = registeredQuest
      ? registeredQuest
      : {
          ...template,
          creator: address,
          chainQuestId,
          status: "ACCEPTED",
        };

    setLastGeneratedQuest(persistedQuest);
    patchQuest(questMatcher(questToAccept), persistedQuest);
    upsertQuest(persistedQuest);
    setRevealQuestModal(false);
    setMessage(
      "Quest accepted! Complete the objective and submit proof below.",
    );
    await syncNow();
  } catch (error) {
    console.error("[CommandCenter] handleAcceptQuest failed", error);
    setMessage(formatActionFailure(error, "Quest acceptance failed."));
  } finally {
    setLoading(false);
  }
}
```

### 3. submitForgeWrite() - The Transaction Handler

**File:** `frontend/src/pages/CommandCenter.tsx` (line 672)

```typescript
async function submitForgeWrite(
  functionName: "createQuest" | "startQuest" | "submitQuest" | "claimReward",
  args: unknown[],
  options?: { value?: bigint; gasLimit?: bigint },
) {
  if (!forgeQuestManager) throw new Error("Contract interface is not ready");
  if (!provider) throw new Error("Wallet provider is not ready");
  if (!address) throw new Error("Wallet address is not available");

  const txLabel = formatTxLabel(functionName); // e.g., 'Forge quest'

  try {
    if (!isMiniPay) {
      // Standard wallet path (MetaMask, etc.)

      if (!signer) throw new Error("Wallet signer is unavailable");

      // Verify contract method exists
      if (
        typeof (forgeQuestManager as ethers.Contract)[functionName] !==
        "function"
      ) {
        const availableMethods = Object.getOwnPropertyNames(
          forgeQuestManager,
        ).filter(
          (m) =>
            typeof (forgeQuestManager as Record<string, unknown>)[m] ===
            "function",
        );
        throw new Error(
          `Method '${functionName}' not found on ForgeQuestManager contract. ` +
            `Available methods: ${availableMethods.slice(0, 5).join(", ")}`,
        );
      }

      // Build transaction options
      const txOptions: Record<string, unknown> = {};
      if (typeof options?.value === "bigint") {
        txOptions.value = options.value; // ← 0.001 CELO passed here
      }
      if (typeof options?.gasLimit === "bigint") {
        txOptions.gasLimit = options.gasLimit;
      }

      // Call the contract method with explicit type-safe calls
      let tx: ethers.ContractTransactionResponse;

      if (functionName === "createQuest") {
        // createQuest(string title, string metadataUri, uint256 reward, uint256 xp, uint256 duration)
        tx = await forgeQuestManager.createQuest(
          args[0] as string, // title
          args[1] as string, // metadataUri
          args[2] as bigint, // rewardAmount
          args[3] as bigint, // xpReward
          args[4] as bigint, // durationSeconds
          txOptions, // { value: parseEther('0.001') }
        );
      } else if (functionName === "submitQuest") {
        tx = await forgeQuestManager.submitQuest(
          args[0] as bigint,
          args[1] as string,
          txOptions,
        );
      } else if (functionName === "startQuest") {
        tx = await forgeQuestManager.startQuest(args[0] as bigint, txOptions);
      } else if (functionName === "claimReward") {
        tx = await forgeQuestManager.claimReward(args[0] as bigint, txOptions);
      } else {
        throw new Error(`Unknown function: ${functionName}`);
      }

      // Validate transaction response
      if (!tx || typeof tx.hash !== "string" || !tx.hash.startsWith("0x")) {
        throw new Error(
          `Invalid transaction response from wallet. ` +
            `Expected hash property, got: ${typeof tx?.hash}`,
        );
      }

      console.info(
        "[CommandCenter] Transaction submitted to wallet successfully",
        {
          functionName,
          txHash: tx.hash,
        },
      );

      // Update UI
      setTxStatus({
        type: "pending",
        hash: tx.hash,
        label: `${txLabel} pending`,
        message: "Approve the wallet prompt and wait for Celo confirmation.",
      });

      // Wait for confirmation
      const receipt = await tx.wait();

      console.info("[CommandCenter] Transaction confirmed", {
        functionName,
        txHash: tx.hash,
        blockNumber: receipt?.blockNumber,
        status: receipt?.status,
      });

      setTxStatus({
        type: "confirmed",
        hash: tx.hash,
        label: `${txLabel} confirmed`,
        message: "The chain step settled successfully.",
      });

      return { hash: tx.hash, receipt };
    } else {
      // MiniPay wallet path

      if (!walletProvider) throw new Error("MiniPay provider is unavailable");

      const signerAddress = await signer?.getAddress();

      // Estimate gas with fallback
      let gasLimit = options?.gasLimit;
      if (!gasLimit) {
        try {
          gasLimit = await estimateContractWriteGas({
            provider: walletProvider,
            contractAddress: contractAddresses.forgeQuestManagerAddress,
            contractInterface: forgeQuestManager.interface,
            functionName,
            args,
            from: signerAddress || address,
            ...(typeof options?.value === "bigint"
              ? { value: options.value }
              : {}),
          });
        } catch (estimationError) {
          console.warn(
            "[CommandCenter] Gas estimation failed, using fallback",
            {
              error:
                estimationError instanceof Error
                  ? estimationError.message
                  : String(estimationError),
            },
          );

          // Use sensible defaults
          gasLimit =
            functionName === "createQuest"
              ? BigInt("300000") // createQuest needs more gas
              : BigInt("200000"); // other functions
        }
      }

      // Send transaction
      const { txHash } = await sendContractWrite({
        provider: walletProvider,
        contractAddress: contractAddresses.forgeQuestManagerAddress,
        contractInterface: forgeQuestManager.interface,
        functionName,
        args,
        from: address,
        gasLimit,
        ...(typeof options?.value === "bigint" ? { value: options.value } : {}),
      });

      // Validate transaction hash
      if (!txHash || typeof txHash !== "string" || !txHash.startsWith("0x")) {
        throw new Error(
          `Invalid transaction hash from MiniPay. ` +
            `Expected hash string, got: ${typeof txHash}`,
        );
      }

      console.info(
        "[CommandCenter] MiniPay transaction submitted successfully",
        {
          functionName,
          txHash,
        },
      );

      setTxStatus({
        type: "pending",
        hash: txHash,
        label: `${txLabel} submitted`,
        message:
          "MiniPay submitted the transaction. Waiting for confirmation on Celo.",
      });

      // Wait for confirmation
      const receipt = await waitForTransactionReceipt(provider, txHash);

      setTxStatus({
        type: "confirmed",
        hash: txHash,
        label: `${txLabel} confirmed`,
        message: "Celo confirmed the transaction.",
      });

      return { hash: txHash, receipt };
    }
  } catch (error) {
    console.error("[CommandCenter] submitForgeWrite failed", {
      functionName,
      errorName: error instanceof Error ? error.name : "Unknown",
      errorMessage: error instanceof Error ? error.message : String(error),
      isMiniPay,
      hasForgeQuestManager: !!forgeQuestManager,
      hasSigner: !!signer,
      hasProvider: !!provider,
    });

    setTxStatus({
      type: "error",
      label: `${txLabel} failed`,
      message: formatActionFailure(error, "Transaction failed"),
    });

    throw error;
  }
}
```

### 4. Smart Contract Receives Transaction

**File:** `contracts/contracts/ForgeQuestManager.sol` (line 130)

```solidity
function createQuest(
    string calldata title,
    string calldata metadataUri,
    uint256 rewardAmount,
    uint256 xpReward,
    uint256 durationSeconds
) external payable whenNotPaused rewardSystemActive nonReentrant {

    // ✓ Verify 0.001 CELO was sent
    require(msg.value == ACCEPTANCE_FEE, "Accept fee required");  // ACCEPTANCE_FEE = 0.001 CELO

    // ✓ Transfer fee to treasury
    (bool success, ) = payable(treasury).call{value: msg.value}("");
    require(success, "Fee transfer failed");

    // ✓ Validate inputs
    require(bytes(title).length > 0, "Title required");
    require(rewardAmount > 0, "Reward required");
    require(xpReward > 0, "XP reward required");
    require(durationSeconds > 0, "Duration required");

    // ✓ Create quest
    uint256 questId = nextQuestId;
    nextQuestId += 1;

    // ✓ Store quest state
    quests[questId] = Quest({
        questId: questId,
        creator: msg.sender,  // ← The user's wallet
        title: title,
        metadataUri: metadataUri,
        proofUri: "",
        rewardAmount: rewardAmount,
        xpReward: xpReward,
        createdAt: block.timestamp,
        startedAt: block.timestamp,
        expiresAt: block.timestamp + durationSeconds,
        status: QuestStatus.Accepted,  // ← Status set to Accepted
        player: msg.sender,
        // ... other fields
    });

    playerQuestIndices[msg.sender].push(questId);
    reputation.initializePlayer(msg.sender);

    // ✓ Emit event with questId so frontend can link it
    emit QuestCreated(
        questId,           // ← chainQuestId extracted by frontend
        msg.sender,
        title,
        rewardAmount,
        xpReward
    );
}
```

### 5. Backend Syncs the Quest

**File:** `frontend/src/pages/CommandCenter.tsx` (line 1055)

```typescript
const registeredQuest = await registerOnchainQuestWithRetry(
  String(template.id), // questId (from local generation)
  chainQuestId, // questId from contract (from QuestCreated event)
  creationTxHash, // transaction hash
);
```

**API Endpoint:** `POST /quests/register-onchain`

```typescript
{
  questId: "uuid-from-generation",
  chainQuestId: "1234",
  creationTxHash: "0xabcd..."
}
```

**File:** `backend/src/controllers/questController.ts` (line 530)

```typescript
export async function registerOnchainQuest(req: Request, res: Response) {
  const { questId, chainQuestId, creationTxHash } = req.body;
  const wallet = req.auth?.wallet;  // Authenticated user

  // 1. Verify transaction on chain
  const receipt = await contracts.provider.getTransactionReceipt(creationTxHash);
  require(receipt?.status === 1, "Transaction not confirmed");

  // 2. Parse QuestCreated event
  const parsedLog = parseReceiptEvent(receipt, {...}, 'QuestCreated');
  const eventQuestId = BigInt(parsedLog.args.questId.toString());
  const eventCreator = parsedLog.args.creator;

  // 3. Validate quest IDs match
  require(eventQuestId === BigInt(chainQuestId), "Quest ID mismatch");

  // 4. Validate creator matches authenticated wallet
  require(eventCreator === wallet, "Creator mismatch");

  // 5. Update database
  const updatedQuest = await prisma.quest.update({
    where: { id: questId },
    data: {
      chainQuestId: chainQuestId,
      status: 'ACCEPTED',              // ← Status updated
      player: { connect: { id: user.id } },
      startedAt: new Date(),
      stakeAmount: 0
    }
  });

  // 6. Reserve reward in treasury
  await prisma.treasuryPayout.upsert({
    where: { questId },
    create: {
      questId,
      userId: user.id,
      chainQuestId,
      playerWallet: wallet,
      rewardAmount: quest.rewardAmount,
      totalAmount: quest.rewardAmount,
      status: 'RESERVED'
    }
  });

  return res.json({ quest: updatedQuest });
}
```

---

## Value Breakdown: 0.001 CELO

```typescript
// In handleAcceptQuest:
{ value: ethers.parseEther('0.001') }

// Converts to:
// ethers.parseEther('0.001') = BigInt('1000000000000000')
// = 1,000,000,000,000,000 wei (18 decimals for CELO)
// = 0.001 CELO

// In smart contract:
require(msg.value == ACCEPTANCE_FEE);  // ACCEPTANCE_FEE = 0.001 CELO constant

// Transferred to treasury:
(bool success, ) = payable(treasury).call{value: msg.value}("");
```

---

## Error Messages & Solutions

| Error                                               | Cause                      | Solution                                        |
| --------------------------------------------------- | -------------------------- | ----------------------------------------------- |
| "Method 'createQuest' not found on contract"        | Contract not initialized   | Verify signer exists, contract ABI correct      |
| "Invalid transaction response from wallet"          | Wallet returned bad data   | Reconnect wallet, try again                     |
| "Quest creation receipt did not include a quest id" | Event parsing failed       | Check QuestCreated event is emitted by contract |
| "Gas estimation failed, using fallback"             | MiniPay RPC timeout        | Expected, fallback gas used automatically       |
| "Approve the wallet prompt..." stuck                | Wallet UI didn't appear    | Check wallet permissions, try reconnecting      |
| "Only generated quests can be accepted"             | Quest status not AVAILABLE | Generate new quest first                        |

---

## Testing Sequence

```
1. Open app → Connect MetaMask
   ✓ Should show wallet address

2. Generate Quest
   ✓ Should show quest details
   ✓ Status should be AVAILABLE

3. Click "Accept Quest"
   ✓ Should see: "Approve a 0.001 CELO transaction to begin."
   ✓ Should see message: "Accepting the quest onchain..."
   ✓ MetaMask popup should appear within 1 second
   ✓ Transaction should show 0.001 CELO value

4. Approve in MetaMask
   ✓ Popup closes
   ✓ Console shows: "[CommandCenter] Transaction submitted to wallet successfully"
   ✓ UI shows pending status with transaction hash

5. Wait for confirmation
   ✓ Block explorer shows transaction confirmed
   ✓ Console shows: "[CommandCenter] Transaction confirmed"
   ✓ Quest status changes to "ACCEPTED"
   ✓ "Submit Proof" button appears

✓ All steps complete!
```
