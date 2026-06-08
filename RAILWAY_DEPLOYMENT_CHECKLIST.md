# ForgeQuest Online - Railway Deployment Checklist

**Status:** ✅ Ready for Deployment (May 24, 2026)

Use this checklist to deploy ForgeQuest Online to Railway with all fixes applied.

---

## Pre-Deployment Preparation

### Code Changes Applied ✅

- [x] Backend Dockerfile updated (uses entrypoint script)
- [x] Created `/backend/entrypoint.sh` (runs migrations)
- [x] Updated `.env.production` (contract addresses)
- [x] Updated `frontend/.env` (contract addresses)
- [x] Created deployment guides

### Local Testing (Before Railway)

- [ ] Verify Docker image builds locally:
  ```bash
  cd backend && docker build -t questforge-backend:latest .
  ```
- [ ] Verify migrations exist:
  ```bash
  ls backend/prisma/migrations/
  ```
- [ ] Verify contract addresses in celo-addresses.json:
  ```bash
  cat contracts/deployments/celo-addresses.json
  ```

---

## Railway Setup (Step 1-3)

### 1. Create Railway Project

- [ ] Go to https://railway.app
- [ ] Create new project: "ForgeQuest Online"
- [ ] Accept Railway terms

### 2. Add PostgreSQL Plugin

- [ ] Click "Add Plugin"
- [ ] Select "PostgreSQL"
- [ ] Configure size: "Small" (minimum)
- [ ] Create

### 3. Add Redis Plugin (Optional but recommended)

- [ ] Click "Add Plugin"
- [ ] Select "Redis"
- [ ] Create

---

## Backend Service Configuration (Step 4)

### 4a. Create Backend Service

- [ ] Click "New Service"
- [ ] Select "GitHub" → Connect your repo
- [ ] Select repository containing ForgeQuest Online
- [ ] Root directory: (leave empty)
- [ ] GitHub branch: (your deployment branch, usually `main`)
- [ ] Name: `questforge-backend`
- [ ] Create

### 4b. Configure Service Settings

- [ ] Go to Service → Settings
- [ ] **Public networking:** Turn ON
- [ ] **Port:** 4000
- [ ] **Start command:** (leave empty - Dockerfile ENTRYPOINT will handle it)
- [ ] **Build command:** (leave empty - Dockerfile will build)

### 4c. Link Database Plugin

- [ ] Go to Service → Plugins
- [ ] Click "Add" → PostgreSQL
- [ ] Link the PostgreSQL you created earlier
- [ ] This auto-populates `DATABASE_URL` variable

### 4d. Link Redis Plugin (if created)

- [ ] Go to Service → Plugins
- [ ] Click "Add" → Redis
- [ ] Link the Redis you created earlier
- [ ] This auto-populates `REDIS_URL` variable

---

## Environment Variables Configuration (Step 5)

### 5a. Critical Variables

Go to Service → Variables and set these EXACTLY:

```
CELO_RPC_URL=https://forno.celo.org
CELO_CHAIN_ID=42220
NODE_ENV=production
JWT_EXPIRES_IN=15m
```

- [ ] CELO_RPC_URL set
- [ ] CELO_CHAIN_ID set to 42220
- [ ] NODE_ENV set to production
- [ ] JWT_EXPIRES_IN set to 15m

### 5b. Smart Contract Addresses (MAINNET)

Copy these EXACTLY from the checklist:

```
FORGE_QUEST_MANAGER_ADDRESS=0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2
REPUTATION_ADDRESS=0x8aB46e0Bf56EC119DEfd8c279b75ce19E72B083c
REWARD_NFT_ADDRESS=0xc9539e553acC578d063A23B3F4f62C760356Cf6D
TREASURY_ADDRESS=0xEdFdE2946D0D31a636CE115d0026Ce6096957D5B
REWARD_TOKEN_ADDRESS=0x765de816845861e75A25fca122BB6898B6f02949
```

- [ ] FORGE_QUEST_MANAGER_ADDRESS = 0xFDF...d2
- [ ] REPUTATION_ADDRESS = 0x8aB...3c
- [ ] REWARD_NFT_ADDRESS = 0xc95...D
- [ ] TREASURY_ADDRESS = 0xEdF...5B
- [ ] REWARD_TOKEN_ADDRESS = 0x765...49

### 5c. Secret Variables (ENCRYPTED)

Generate these securely:

#### JWT_SECRET (required)

```bash
# Generate on your local machine
openssl rand -hex 32
# Example output: 7f8c9e1a3b4c5d6e7f8c9e1a3b4c5d6e7f8c9e1a3b4c5d6e7f8c9e1a3b4c5d
```

- [ ] JWT_SECRET = (your 32-char hex string)

#### VERIFIER_PRIVATE_KEY (required in production)

- [ ] VERIFIER_PRIVATE_KEY = (raw private key for wallet with `VERIFIER_ROLE`)
- [ ] Must be a 32-byte hex private key: `0x` followed by 64 hex characters
- [ ] Do not use the public wallet address, mnemonic phrase, placeholder text, or `${{...}}` template

#### GROQ_API_KEY (required in production)

- [ ] GROQ*API_KEY = gsk*... (for AI quest generation)
- [ ] GROQ_MODEL = llama-3.3-70b-versatile
- [ ] Leave blank only for non-production development

### 5d. Frontend URLs (update after frontend deployment)

You'll set these after deploying the frontend:

```
FRONTEND_URL=https://questforge-frontend-xxxx.railway.app
CORS_ORIGIN=https://questforge-frontend-xxxx.railway.app
API_URL=${{Railway.PublicUrl}}
```

For now:

- [ ] FRONTEND_URL = (update after frontend deploy)
- [ ] CORS_ORIGIN = (update after frontend deploy)

### 5e. Feature Flags

- [ ] WEBSOCKET_ENABLED = true (or leave unset, defaults to true)
- [ ] ENABLE_EVENT_STREAM = false (or true if using Redis)

---

## Backend Deployment (Step 6)

### 6a. Deploy

- [ ] Push your code to GitHub (which has the fixes):
  ```bash
  git add -A
  git commit -m "Deploy: Fix migrations and contract addresses"
  git push origin main
  ```
- [ ] OR Click "Deploy" button in Railway dashboard

### 6b. Monitor Deployment

- [ ] Go to Service → Deployments
- [ ] Watch the build log
- [ ] Wait for "Deployment successful" message

### 6c. Check Logs

- [ ] Go to Service → Logs
- [ ] Look for these success messages:
  ```
  [ENTRYPOINT] Running database migrations...
  [ENTRYPOINT] Migrations completed successfully
  [STARTUP] Service initializing: database
  [STARTUP] Service ready: database
  [STARTUP] Service initializing: worldState
  [STARTUP] Service ready: worldState
  [STARTUP] Background services ready
  ```
- [ ] NOT see "relation X does not exist" errors
- [ ] Application is running on port 4000

### 6d. Get Backend URL

- [ ] Go to Service → Settings
- [ ] Copy the "Public Domain" URL
- [ ] Example: `https://questforge-backend-xxxx.railway.app`

---

## Backend Verification (Step 7)

### 7a. Health Checks

```bash
# Replace with your actual backend URL
BACKEND_URL="https://questforge-backend-xxxx.railway.app"

# Test basic health
curl -X GET "$BACKEND_URL/health" | jq .
```

- [ ] Returns HTTP 200
- [ ] JSON contains "ok": true

```bash
# Test readiness
curl -X GET "$BACKEND_URL/health/ready" | jq .
```

- [ ] Returns HTTP 200
- [ ] JSON contains "ready": true

### 7b. Database Verification

- [ ] Check logs show no table errors
- [ ] Look for "WorldStateSnapshot" in schema (not "does not exist")
- [ ] Look for "Quest" table initialization

### 7c. Contract Verification

- [ ] Logs show contract addresses loaded
- [ ] No "invalid address" errors
- [ ] Addresses match celo-addresses.json

---

## Frontend Deployment (Step 8)

### 8a. Create Frontend Service

- [ ] Click "New Service" in Railway
- [ ] Select GitHub → your repo
- [ ] Name: `questforge-frontend`
- [ ] Create

### 8b. Configure Frontend

- [ ] Go to Service → Settings
- [ ] **Build command:** `npm install && npm run build`
- [ ] **Start command:** `npm run preview`
- [ ] **Port:** 5173
- [ ] **Public networking:** ON

### 8c. Frontend Environment Variables

- [ ] Set `VITE_API_BASE_URL=${{questforge-backend.RAILWAY_PUBLIC_URL}}/api`
- [ ] Set `VITE_CELO_CHAIN_ID=42220`
- [ ] Set `VITE_CELO_RPC_URL=https://forno.celo.org`
- [ ] Set other VITE\_\* contract address variables (from frontend/.env)

### 8d. Deploy Frontend

- [ ] Push changes to GitHub
- [ ] Monitor deployment logs
- [ ] Wait for "Deployment successful"

### 8e. Get Frontend URL

- [ ] Go to Service → Settings
- [ ] Copy "Public Domain" URL
- [ ] Example: `https://questforge-frontend-xxxx.railway.app`

---

## Update Backend with Frontend URL (Step 9)

### 9a. Update Backend Environment

- [ ] Go back to `questforge-backend` service
- [ ] Go to Variables
- [ ] Update `FRONTEND_URL` = your frontend URL
- [ ] Update `CORS_ORIGIN` = your frontend URL
- [ ] Save

### 9b. Redeploy Backend

- [ ] Backend will auto-redeploy
- [ ] Monitor logs for startup
- [ ] Should show "CORS origins configured"

---

## Full Integration Test (Step 10)

### 10a. Test Frontend

- [ ] Open frontend URL in browser
- [ ] Should load without console errors
- [ ] Check browser DevTools → Console
- [ ] No CORS errors

### 10b. Test Wallet Connection

- [ ] Click "Connect Wallet" button
- [ ] Can see wallet options:
  - [ ] MetaMask
  - [ ] WalletConnect
  - [ ] Celo Wallet
  - [ ] Other Web3 options

### 10c. Test API Communication

Open browser console:

```javascript
// Test API connectivity
fetch("https://questforge-backend-xxxx.railway.app/api/health")
  .then((r) => r.json())
  .then((d) => console.log("Backend health:", d));
```

- [ ] See health status returned
- [ ] No network errors

### 10d. Test MiniPay (Mobile)

**Requires Android device with MiniPay installed**

- [ ] Install MiniPay app on test device
- [ ] Open MiniPay's dapp browser
- [ ] Navigate to frontend URL
- [ ] Test "Connect Wallet"
- [ ] Should show MiniPay as option
- [ ] Can sign in with MiniPay wallet

### 10e. Test Quest Features

- [ ] Can view quests
- [ ] Can initiate a claim
- [ ] Backend processes the request
- [ ] No database errors in logs

---

## Production Monitoring Setup (Step 11)

### 11a. Enable Railway Monitoring

- [ ] Go to Project → Settings
- [ ] Enable "Email Alerts"
- [ ] Set alert conditions:
  - [ ] Service down
  - [ ] High memory usage
  - [ ] High CPU usage

### 11b. Check Logs Regularly

- [ ] Monitor logs daily for first week
- [ ] Look for errors or warnings
- [ ] Check for any failed quests or transactions

### 11c. Set Up Backup

- [ ] Railway Postgres auto-backups enabled by default
- [ ] Verify in Postgres plugin → Settings

---

## Troubleshooting Checklist

### ❌ If "relation X does not exist" error:

- [ ] Verify migrations ran: Check logs for "Migrations completed successfully"
- [ ] Check DATABASE_URL is correct
- [ ] Manually trigger redeploy

### ❌ If contract addresses not found:

- [ ] Verify each address is copied exactly (case-sensitive)
- [ ] Check CELO_RPC_URL = https://forno.celo.org
- [ ] Verify CELO_CHAIN_ID = 42220

### ❌ If CORS errors:

- [ ] Verify CORS_ORIGIN matches your frontend URL exactly
- [ ] Check FRONTEND_URL matches public domain
- [ ] Redeploy backend after updating

### ❌ If MiniPay won't connect:

- [ ] Verify VITE_CELO_CHAIN_ID = 42220
- [ ] Check contract addresses in frontend/.env
- [ ] Verify frontend CORS includes MiniPay origin

---

## Sign-Off

- [ ] All code changes deployed
- [ ] Backend running successfully
- [ ] Frontend running successfully
- [ ] Health checks passing
- [ ] CORS configured correctly
- [ ] Contract addresses verified
- [ ] Database migrations completed
- [ ] MiniPay tested (or planned)
- [ ] Monitoring enabled
- [ ] Team notified of deployment

---

## Quick Reference

**Backend URL:** https://questforge-backend-xxxx.railway.app  
**Frontend URL:** https://questforge-frontend-xxxx.railway.app  
**Health Endpoint:** /health  
**Ready Endpoint:** /health/ready  
**Chain ID:** 42220 (Celo Mainnet)  
**RPC Endpoint:** https://forno.celo.org

**Contract Addresses (Mainnet):**

- ForgeQuestManager: 0xFDF8901BB33Bd52ef199F3d3E6647b8a1f86D2d2
- Reputation: 0x8aB46e0Bf56EC119DEfd8c279b75ce19E72B083c
- RewardNFT: 0xc9539e553acC578d063A23B3F4f62C760356Cf6D
- Treasury: 0xEdFdE2946D0D31a636CE115d0026Ce6096957D5B

---

**Deployment Status: ✅ READY**  
**Last Updated: May 24, 2026**  
**All critical issues resolved**
