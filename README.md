# QuestForge AI

QuestForge AI is a premium onchain fantasy RPG platform built for hackathons. Players connect real wallets, accept AI-generated quests, complete blockchain missions, stake tokens, and earn NFT rewards on Celo.

## Project Structure

- `frontend/` — Vite + React + TypeScript + Tailwind + Framer Motion.
- `backend/` — Express + TypeScript + Prisma + PostgreSQL + Groq AI integration.
- `contracts/` — Solidity smart contracts with Hardhat, ERC20 reward support, ERC721 achievement NFTs, treasury, reputation, and quest management.

## Highlights

- WalletConnect and MiniPay wallet support
- Celo chain detection and network switching
- AI-powered Quest Forge Master agent
- Dynamic daily quests, NPC dialogue, and lore
- Multi-transaction quest lifecycle
- Onchain staking, reward payout, NFT minting
- Leaderboards, achievements, player progression
- Glassmorphism UI with cinematic yellow / navy theme

## Setup

### 1. Backend

```bash
cd backend
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run dev
```

From the repo root, the equivalent Prisma commands are:

```bash
npm run prisma:generate
npm run prisma:migrate -- --name init
```

### 2. Contracts

```bash
cd contracts
npm install
npx hardhat compile
```

Deploy the contracts and update `backend/.env` with deployed addresses.

### 3. Frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Set the deployed contract addresses in `frontend/.env` before launching the app.

## Deployment

- Frontend: Vercel
- Backend: Railway
- Contracts: Hardhat deploy to Celo

## Deployment

- Frontend: Vercel deploy from `frontend/`, use `VITE_API_BASE_URL` in environment variables.
- Backend: Railway deploy from `backend/`, use `DATABASE_URL`, `GROQ_API_KEY`, `GROQ_MODEL`, `PRIVATE_KEY`, and contract address variables from `.env.example`.
- Contracts: deploy with Hardhat and set `FORGE_QUEST_MANAGER_ADDRESS`, `REWARD_NFT_ADDRESS`, `REPUTATION_ADDRESS`, and `TREASURY_ADDRESS` in backend and frontend env files.

## Notes

The application is designed to maximize meaningful onchain activity while delivering an immersive AI-driven fantasy adventure experience.
