# Remaining Stake References

## Summary

This report captures the remaining runtime and business references to `stake`/`stakeAmount` in the repository. The current migration is partially complete: quest generation now produces zero stake, but the codebase still retains compatibility references, type definitions, and historical event handling.

## Runtime source references

### backend/src/controllers/questController.ts

- `stakeAmount` is still included in generated quest payloads and database upserts.
- The API response returns `stakeAmount` for generated quests.
- `ruleBasedQuestEngine.generateQuest()` currently supplies `generated.quest.stakeAmount`, which is zero.

### backend/src/services/authoritativeEventProjector.ts

- Reward event handlers still parse `payload.stakeAmount` from treasury events.
- `handleRewardReleased()` calculates `stakeAmount` and `totalAmount` from `payload.stakeAmount`.
- `handleRewardRefunded()` also parses `stakeAmount` from payload and uses it to calculate `totalAmount`.
- These branches are stale because current `Treasury` events no longer include `stakeAmount` and the contract now uses reward-only settlement semantics.

### backend/src/services/verification.ts

- `syncSuccessfulSettlementArtifacts()` reads `input.onchainQuest.stakeAmount` and includes it in logs, DB upserts, and realtime payloads.
- `syncFailedSettlementArtifacts()` reads `refundEvent.args?.stakeAmount` and `input.onchainQuest.stakeAmount`, even though refund events no longer include stake and quests now represent the fee as a zero-value field.

### backend/src/services/questValidationEngine.ts

- `validateGeneratedQuest()` still declares a `stakeAmount` variable, uses it for reward-bound validation, and embeds it in metadata.
- This is a business-level holdover; the effective value is now `0`.

### backend/src/services/ruleBasedQuestEngine.ts

- Difficulty profiles still include `stakeBounds` and `recommendedStake`.
- `buildDifficultyProfile()` sets `recommendedStake: 0` but the field remains present across the generation pipeline.

### backend/src/services/questOrchestrationTypes.ts

- Types still define `stakeBounds`, `recommendedStake`, and `stakeAmount` in `ValidatedQuestOutput` and `QuestValidationInput`.

### backend/src/controllers/realtimeController.ts

- The `TreasuryPayoutRow` type still includes `stakeAmount`.
- Realtime bootstrap payloads continue carrying treasury payout rows with `stakeAmount`.

### backend/src/services/contracts.ts

- The onchain ABI for `quests(uint256)` still exposes `stakeAmount` as a returned struct field.
- This is a contract compatibility artifact; the runtime currently stores it as zero.

## Frontend references

### frontend/src/pages/CommandCenter.tsx

- `GeneratedQuestTemplate` still includes `stakeAmount` in its type.
- The frontend currently defines this field even though it is not used in core quest display.

### frontend/src/context/RealtimeContext.tsx

- `QuestState` still includes `stakeAmount`.

### frontend/src/lib/contracts.ts

- The frontend side contract ABI still declares `stakeAmount` in the `quests` tuple.

### frontend/src/lib/transactionDiagnostics.ts

- Error diagnostics still reference `required stake` and `stake mismatch` in wallet transaction failure messaging.

## Contract / on-chain compatibility

### contracts/contracts/ForgeQuestManager.sol

- The contract now uses `ACCEPTANCE_FEE = 0.001 ether`.
- `createQuest()` requires the acceptance fee instead of staking a variable amount.
- The stored `Quest` struct still includes a legacy `stakeAmount` field set to `0`.

### contracts/contracts/Treasury.sol

- Treasury settlement events now emit reward-only amounts (`rewardAmount`, `totalPayout`), not stake amounts.
- `refundQuest()` returns `refundedStakeAmount = 0` and emits `RewardRefunded` without `stakeAmount`.

## Stale generated artifacts

- `backend/dist/` still contains old compiled code with `stake:locked` event handling and AI service references.
- `backend/dist/services/aiDifficultyEngine.js`, `backend/dist/services/aiQuestGenerationEngine.js`, `backend/dist/services/aiRewardEngine.js`, and other `dist` files still expose AI/stake calculations.
- These dist artifacts are stale and should not be used to judge current source behavior.

## Documentation and audit artifacts

- Numerous markdown files in the repository still refer to staking, stake locking, reward staking, and AI-based quest generation.
- These documents will require a separate migration/audit pass.

## Recommended next steps

1. Remove stale treasury event stake parsing in `backend/src/services/authoritativeEventProjector.ts`.
2. Simplify reward/refund total amount calculations to use `rewardAmount` only.
3. Introduce `acceptanceFee` as the business term in verification and settlement logging while preserving database compatibility as `stakeAmount`.
4. Continue auditing frontend and API payload types for legacy `stakeAmount` references.
5. Replace stale `backend/dist/` artifacts by rebuilding after source changes.
