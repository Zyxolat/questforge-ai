# Fix for "no data present; likely require(false)" Error

## Root Cause Analysis

**The Accept Quest button fails with error:**

```
no data present; likely require(false) occurred code=CALL_EXCEPTION code=-32603
```

**Actual Error:** Treasury contract has insufficient liquidity to reserve quest rewards.

The smart contract fails at this check in `Treasury.sol`:

```solidity
require(_hasRewardLiquidity(rewardAmount), "Insufficient treasury liquidity");
```

### Why This Happens

1. **Treasury deployed with 0 CELO** - During production deployment, the `INITIAL_NATIVE_REWARD_POOL_CELO` environment variable was not set
2. **Deployment script checks** - When deploying to Celo (production), the script only funds Treasury if env var is explicitly provided:
   ```typescript
   if (initialNativeRewardPool && initialNativeRewardPool > 0n) {
     // Fund treasury - BUT initialNativeRewardPool is null for production!
   }
   ```
3. **Quest generation creates rewards** - Backend generates quests with reward amounts (e.g., 0.1-0.3 CELO)
4. **Transaction fails** - When user clicks Accept Quest, contract tries to reserve reward but Treasury has 0 balance

## Solution: Fund the Treasury

### For Production Deployment

The Treasury must have sufficient CELO balance to cover quest rewards. We've created `contracts/scripts/fundTreasury.ts` to do this.

**Step 1: Prepare Environment**

Set these environment variables:

```bash
export TREASURY_ADDRESS="0x..." # Your deployed Treasury address
export FUND_AMOUNT="10"          # Amount of CELO to send (default: 5)
export PRIVATE_KEY="0x..."       # Owner's private key (must have CELO)
```

**Step 2: Run Funding Script**

```bash
cd /home/zyxolat/Desktop/QuestForge\ AI/contracts

# Fund on Celo Mainnet
npx hardhat run scripts/fundTreasury.ts --network celo

# Or fund on test network
npx hardhat run scripts/fundTreasury.ts --network localhost
```

**Step 3: Verify Funding**

```bash
# Check Treasury balance
npx hardhat run scripts/validateDeployment.ts --network celo
```

You should see:

```
treasuryBalance: "10.0" CELO
treasuryLiquidity: "10.0" CELO
```

### For New Deployments

Modify `contracts/.env.production` before deploying:

```env
# Add this line to fund Treasury on deployment
INITIAL_NATIVE_REWARD_POOL_CELO=10
```

Then deploy normally:

```bash
npx hardhat run scripts/deploy.ts --network celo
```

## Understanding Treasury Liquidity

The Treasury tracks:

- **Balance**: Total CELO in the contract
- **Obligations**: CELO reserved for pending/approved quests
- **Liquidity**: `Balance - Obligations`

For a quest to be accepted:

```
Treasury.balance >= Treasury.obligations + questRewardAmount
```

### Example Scenario

| Transaction | Balance | Obligations | Liquidity | Can Accept Quest?              |
| ----------- | ------- | ----------- | --------- | ------------------------------ |
| Initial     | 0 CELO  | 0 CELO      | 0 CELO    | ❌ No (0 balance)              |
| Fund +10    | 10 CELO | 0 CELO      | 10 CELO   | ✅ Yes (quests up to 10 CELO)  |
| Accept 0.5  | 10 CELO | 0.5 CELO    | 9.5 CELO  | ✅ Yes (remaining 9.5 CELO)    |
| Accept 0.3  | 10 CELO | 0.8 CELO    | 9.2 CELO  | ✅ Yes (remaining 9.2 CELO)    |
| Accept 10   | 10 CELO | 10.8 CELO   | -0.8 CELO | ❌ No (insufficient liquidity) |

## Recommended Funding Amounts

- **For Testing**: 5-10 CELO (covers ~20-50 test quests at 0.1-0.2 CELO each)
- **For Staging**: 25-50 CELO (covers frequent testing)
- **For Production**: 100+ CELO (covers many concurrent quests with buffer)

### Calculation Formula

```
Required Balance = Expected Concurrent Quests × Average Reward + Buffer
```

Example for 50 concurrent quests at 0.2 CELO average with 25% buffer:

```
50 × 0.2 × 1.25 = 12.5 CELO needed
```

## How Quest Rewards Work

1. **Quest Created**: User pays 0.001 CELO acceptance fee (goes to Treasury)
2. **Reward Reserved**: Treasury reserves the quest reward amount (blocked from being used)
3. **Quest Completed**: Verifier marks quest as verified
4. **Reward Claimed**: Player receives the reserved reward

The acceptance fee (0.001 CELO) helps the Treasury stay solvent by providing operational funds.

## Monitoring Treasury Health

Check Treasury status with:

```bash
npx hardhat run scripts/validateDeployment.ts --network celo
```

Look for these indicators:

| Status                       | Meaning                           | Action                  |
| ---------------------------- | --------------------------------- | ----------------------- |
| `treasurySolvent: true`      | ✅ Treasury can cover obligations | None needed             |
| `treasurySolvent: false`     | ❌ Treasury underfunded           | Fund immediately        |
| `treasuryLiquidity < 1 CELO` | ⚠️ Low buffer                     | Consider funding        |
| `totalReservedRewards` high  | ⚠️ Many pending quests            | Encourage reward claims |

## Error Messages

### If Treasury Is Empty

```
Error: no data present; likely require(false) occurred code=CALL_EXCEPTION
└─ Actual error: require(_hasRewardLiquidity(rewardAmount))
```

**Fix**: Run `fundTreasury.ts` script

### If Caller Is Not Owner

```
Error: AccessControl: account 0x... is missing role 0x...
```

**Fix**: Use the owner's private key (set in `PRIVATE_KEY` env var)

### If Treasury Is Paused

```
Error: Pausable: paused
```

**Fix**: Contact contract owner to unpause, or deploy new contracts

## Post-Funding Verification

After funding, users should be able to:

1. ✅ Generate quests (free, backend-only)
2. ✅ Click "Accept Quest" (triggers wallet)
3. ✅ Approve transaction (shows in MetaMask/MiniPay)
4. ✅ See quest status change to "ACTIVE"
5. ✅ Submit proof
6. ✅ Claim reward

## Troubleshooting

### Funding Script Fails with "Insufficient signer balance"

**Problem**: The deployer account doesn't have enough CELO

**Solution**:

1. Send CELO to deployer address
2. Wait for transaction confirmation
3. Re-run funding script

### Funding Script Succeeds but Quests Still Fail

**Problem**: Treasury balance updated but quests still fail

**Solutions**:

1. Check `treasuryObligations` - if high, wait for players to claim rewards
2. Fund Treasury with more CELO
3. Verify smart contract wasn't paused: `npx hardhat run -c "const t = await ethers.getContractAt('Treasury', '0x...'); console.log(await t.paused())" --network celo`

### Show Current Treasury State

```bash
npx hardhat run scripts/validateDeployment.ts --network celo | grep -i treasury
```

Should show:

```
Treasury deployed                     ✓
QUEST_MANAGER_ROLE granted            ✓
Treasury Balance                      X.X CELO
Treasury Obligations                  X.X CELO
Treasury Available Liquidity          X.X CELO
Treasury Solvent                      true
```

## Related Files

- **Deploy script**: `contracts/scripts/deploy.ts` (lines 320-330)
- **Funding script**: `contracts/scripts/fundTreasury.ts` (NEW)
- **Treasury contract**: `contracts/contracts/Treasury.sol` (lines 74-92)
- **Validation script**: `contracts/scripts/validateDeployment.ts`

## Next Steps

1. ✅ Create funding script (DONE)
2. ⏳ Fund Treasury on production with sufficient CELO
3. ⏳ Test Accept Quest flow completely
4. ⏳ Monitor Treasury balance
5. ⏳ Set up alerts for low liquidity
