# QuestForge AI Deployment Report

Generated: 2026-05-15T22:35:39.342Z
Environment: development
Network: localhost
Status: SUCCESS
Readiness Score: 95/100

## Contracts

| Contract          | Address                                      |
| ----------------- | -------------------------------------------- |
| RewardNFT         | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` |
| Treasury          | `0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0` |
| Reputation        | `0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9` |
| ForgeQuestManager | `0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9` |

## Validation

- Environment: not_run
- Contracts: pass
- Treasury: fail
- Gameplay: not_run
- Security: not_run

## Next Steps

- 1. Copy the generated addresses into Railway env vars.
- 2. Restart the backend service.
- 3. Run post-deployment validation against Celo.
- 4. Verify treasury funding before opening quests.
