# QuestForge AI — Backend

TypeScript/Node.js API server for QuestForge AI, deployed via Docker on Railway.

## Prerequisites

- Node.js 20+
- PostgreSQL 14+
- A Celo Mainnet RPC endpoint (public: `https://forno.celo.org`)
- Deployed smart contract addresses (see [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md))

## Local Development

```bash
# Install dependencies
npm install

# Copy environment template and fill in values
cp .env.example .env

# Generate Prisma client
npm run prisma:generate

# Run database migrations
npx prisma migrate deploy

# Start development server
npm run dev
```

The server listens on `http://localhost:4000` by default.

## Railway Deployment

> **Important:** The app validates all required environment variables at startup.
> If any are missing, the process exits immediately with
> `Missing required environment variable <NAME>`, and all healthchecks will fail.
> Set every variable marked **[REQUIRED]** in the Railway dashboard
> (service → Variables) **before** your first deploy.

### Required Variables

| Variable                      | Description                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | PostgreSQL connection string. Use `${{Postgres.DATABASE_URL}}` to link the Railway Postgres plugin.                             |
| `FRONTEND_URL`                | Public URL of the deployed frontend, e.g. `https://app.questforge.ai`. Used for CORS and SIWE auth.                             |
| `CORS_ORIGIN`                 | Comma-separated list of allowed CORS origins. Must include `FRONTEND_URL`.                                                      |
| `JWT_SECRET`                  | Random secret, **minimum 32 characters**. Generate with `openssl rand -hex 32`.                                                 |
| `JWT_EXPIRES_IN`              | Token lifetime, e.g. `15m`, `1h`, `7d`.                                                                                         |
| `CELO_RPC_URL`                | Celo Mainnet RPC endpoint. Also accepted as `CELO_NODE_URL`. Required by the backend's on-chain integrations and health checks. |
| `CELO_CHAIN_ID`               | Must be `42220` (Celo Mainnet).                                                                                                 |
| `FORGE_QUEST_MANAGER_ADDRESS` | Deployed `ForgeQuestManager` contract address (checksummed `0x...`).                                                            |
| `REWARD_NFT_ADDRESS`          | Deployed `RewardNFT` contract address.                                                                                          |
| `REPUTATION_ADDRESS`          | Deployed `Reputation` contract address.                                                                                         |
| `TREASURY_ADDRESS`            | Deployed `Treasury` contract address.                                                                                           |

### Optional Variables

| Variable               | Default                   | Description                                                                                                                  |
| ---------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `4000`                    | TCP port the server binds to. Railway sets this automatically.                                                               |
| `GROQ_API_KEY`         | —                         | Optional. Leave unset to use deterministic fallback quests.                                                                  |
| `GROQ_MODEL`           | `llama-3.3-70b-versatile` | Groq chat model used for live quest generation.                                                                              |
| `REDIS_URL`            | —                         | Redis connection string for rate limiting. Falls back to in-memory if unset. Required only when `ENABLE_EVENT_STREAM=true`.  |
| `VERIFIER_PRIVATE_KEY` | —                         | Required in production. Private key for the wallet holding `VERIFIER_ROLE` on the contracts. Also accepted as `PRIVATE_KEY`. |
| `ENABLE_EVENT_STREAM`  | `false`                   | Master switch for the blockchain event streaming system. Enable only after `REDIS_URL` is configured.                        |
| `WEBSOCKET_ENABLED`    | `true`                    | Enable Socket.IO for real-time frontend updates.                                                                             |
| `AUTH_COOKIE_SECURE`   | `true` in production      | Set to `true` when serving over HTTPS (required in production).                                                              |

See [`.env.example`](.env.example) for the full list of variables with descriptions and default values.

### Conditional Variables

| Condition                  | Variables                               | Notes                                                                                  |
| -------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------- |
| `ENABLE_EVENT_STREAM=true` | `REDIS_URL`                             | Required for the BullMQ queue and worker. Without Redis, startup validation will fail. |
| Production verifier wallet | `VERIFIER_PRIVATE_KEY` or `PRIVATE_KEY` | Required in production. Must be a raw `0x` + 64 hex character private key.             |
| Production AI generation   | `GROQ_API_KEY`                          | Optional; missing or unhealthy Groq enables deterministic fallback quests.             |

## Health Checks

| Endpoint             | Description                                         |
| -------------------- | --------------------------------------------------- |
| `GET /health`        | Overall service health (database, blockchain, API). |
| `GET /health/events` | Detailed event streaming and indexer status.        |

Railway is configured to use `/health` as the healthcheck path (`backend/railway.json`).

## Project Structure

```
src/
├── config/
│   ├── env.ts          # Environment variable validation — loaded at startup
│   └── production.ts   # Production health check logic
├── controllers/        # Route handlers
├── middleware/         # Auth, rate limiting
├── routes/             # Express router definitions
└── services/           # Business logic, blockchain, AI, event streaming
prisma/
├── schema.prisma       # Database schema
└── migrations/         # Migration history
```

## Building

```bash
npm run build       # Compile TypeScript → dist/
npm run start       # Run compiled output
npm run dev         # ts-node-dev watch mode
```

The Dockerfile performs a two-stage build: compiles TypeScript in a `build` stage, then copies only the compiled output and production dependencies into the `runtime` image.
