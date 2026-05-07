# QuestForge AI

QuestForge AI is a premium onchain fantasy RPG platform built for hackathons. Players connect real wallets, accept AI-generated quests, complete blockchain missions, stake tokens, and earn NFT rewards on Celo.

## Project Structure

- `frontend/` — Vite + React + TypeScript + Tailwind + Framer Motion.
- `backend/` — Express + TypeScript + Prisma + PostgreSQL + OpenAI integration.
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
npx prisma db push
npm run dev
```

### 2. Contracts

```bash
cd contracts
npm install
npx hardhat compile
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev
```

## Deployment

- Frontend: Vercel
- Backend: Railway
- Contracts: Hardhat deploy to Celo

## Notes

The application is designed to maximize meaningful onchain activity while delivering an immersive AI-driven fantasy adventure experience.
