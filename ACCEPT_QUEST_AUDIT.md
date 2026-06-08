# Accept Quest Architecture Audit

## Summary

The current accept-quest architecture is:

1. `Generate Quest` is free and read-only.
2. `Accept Quest` is the first paid on-chain transaction.
3. `ForgeQuestManager.createQuest()` is the actual acceptance transaction.
4. `registerOnchainQuest()` is a backend sync/validation step, not a second chain transaction.

## Full accept flow

### Frontend

- `frontend/src/pages/CommandCenter.tsx`
  - `handleGenerateQuest()` calls `generateQuest('Celo')` and creates a local `QuestState` with `status: 'AVAILABLE'`.
  - No contract write occurs during generation.
  - `handleAcceptQuest()` is the accept flow.
  - It constructs `createQuest` args and executes:
    - `submitForgeWrite('createQuest', [...createQuestArgs], { value: ethers.parseEther('0.001') })`
  - This sends exactly `0.001` CELO as the acceptance fee.
  - It parses the returned receipt for `QuestCreated` and extracts `chainQuestId`.
  - It then calls `registerOnchainQuestWithRetry(questId, chainQuestId, creationTxHash)`.

### Contract

- `contracts/contracts/ForgeQuestManager.sol`
  - `createQuest(...) external payable` is the accept transaction.
  - It requires `msg.value == ACCEPTANCE_FEE`.
  - It forwards the fee to `treasury`.
  - It reserves reward via `ITreasury(treasury).reserveReward(...)`.
  - It stores the quest with `status: QuestStatus.Accepted` and sets `player = msg.sender`.
  - It emits `QuestCreated(questId, msg.sender, title, rewardAmount, xpReward)`.

### Backend

- `backend/src/controllers/questController.ts`
  - `registerOnchainQuest()` is an authenticated POST endpoint at `/quests/register-onchain`.
  - It validates inputs: `questId`, `chainQuestId`, `creationTxHash`, authenticated wallet.
  - It fetches the transaction receipt and ensures it is confirmed.
  - It parses the `QuestCreated` event from the receipt.
  - It verifies:
    - `event.questId === chainQuestId`
    - `event.creator === authenticated wallet`
  - It updates the local quest row:
    - `chainQuestId`
    - `status: 'ACCEPTED'`
    - `playerId`
    - `startedAt`
    - `stakeAmount: 0`
  - It upserts a `treasuryPayout` reservation for the reward.

## Important architectural classification

- `createQuest()` in `ForgeQuestManager.sol` is the true on-chain accept operation.
- `registerOnchainQuest()` is currently required by the app to bind the generated quest record to the on-chain quest and to persist acceptance state in the backend.
- It is not legacy dead code; it is an active backend bridge.
- However, it is an architectural bridge pattern and could be refactored if the backend moved to event-driven quest reconciliation.

## Repository occurrences

### Active runtime path

- `frontend/src/pages/CommandCenter.tsx`
  - `handleAcceptQuest()` performs on-chain `createQuest` with `0.001` CELO.
  - `registerOnchainQuestWithRetry()` calls the backend sync endpoint.
- `frontend/src/lib/api.ts`
  - `registerOnchainQuest(questId, chainQuestId, creationTxHash)` posts to `/quests/register-onchain`.
- `backend/src/routes/api.ts`
  - Registers `apiRouter.post('/quests/register-onchain', requireAuth, registerOnchainQuest)`.
- `backend/src/controllers/questController.ts`
  - Implements `registerOnchainQuest()` and the backend state persist logic.
- `contracts/contracts/ForgeQuestManager.sol`
  - Implements `createQuest()` and emits `QuestCreated`.

### Validation and supporting code

- `contracts/test/ForgeQuestManager.security.test.ts`
- `contracts/test/integration.test.ts`
  - Verify `createQuest()` behavior and event emission.
- `scripts/audit-proof-verification.ts`
- `scripts/validate-gameplay.ts`
  - Use `chainQuestId` and validate on-chain quest creation and submission.
- `backend/src/services/contracts.ts`
- `backend/src/services/eventDecoder.ts`
- `backend/src/services/authoritativeEventProjector.ts`
- `backend/src/services/eventWorker.ts`
  - Parse and handle `QuestCreated` events for backend event-streaming / state projection.

### Documentation references

- `ARCHITECTURE_CORRECTION_REPORT.md`
- `FINAL_PRE_SUBMISSION_AUDIT.md`
- `QUEST_GENERATION_RUNTIME_REPORT.md`
- `IMPLEMENTATION_AUDIT.md`
- `FEATURE_VERIFICATION.md`
- `COMPREHENSIVE_PRODUCTION_AUDIT.md`

These documents reference the accept flow and/or `registerOnchainQuest`, but are not runtime code.

## Verdict

- The current implementation correctly makes `Accept Quest` the first paid on-chain interaction.
- The contract `createQuest()` enforces the 0.001 CELO fee and accepts the quest.
- `registerOnchainQuest()` remains a required backend sync layer in the present architecture.
- If you want to remove this bridge, the future refactor should replace it with an event-driven reconciliation path that links `QuestCreated` events to generated quests automatically.
