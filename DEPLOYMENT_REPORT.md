# QuestForge AI Deployment Report

Generated: 2026-05-16T00:39:34.710Z
Environment: production
Network: Celo Mainnet
Status: SUCCESS
Readiness Score: 95/100

## Contracts

| Contract          | Address                                      |
| ----------------- | -------------------------------------------- |
| RewardNFT         | `0xc9539e553acC578d063A23B3F4f62C760356Cf6D` |
| Treasury          | `0xEdFdE2946D0D31a636CE115d0026Ce6096957D5B` |
| Reputation        | `0x8aB46e0Bf56EC119DEfd8c279b75ce19E72B083c` |
| ForgeQuestManager | `0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2` |

## Validation

- Environment: fail
- Contracts: pass
- Treasury: fail
- Gameplay: not_run
- Security: not_run

## Next Steps

- 1. Copy the generated addresses into Railway env vars.
- 2. Restart the backend service.
- 3. Run post-deployment validation against Celo.
- 4. Verify treasury funding before opening quests.
