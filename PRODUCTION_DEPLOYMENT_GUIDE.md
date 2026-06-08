# ForgeQuest Online - Complete Production Deployment Guide

**Target Network:** Celo Mainnet  
**Date:** May 10, 2026  
**Status:** Production Ready

---

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Environment Setup](#environment-setup)
3. [Step-by-Step Deployment](#step-by-step-deployment)
4. [Validation & Testing](#validation--testing)
5. [Post-Deployment Setup](#post-deployment-setup)
6. [Monitoring & Maintenance](#monitoring--maintenance)
7. [Emergency Procedures](#emergency-procedures)
8. [Troubleshooting](#troubleshooting)

---

## Pre-Deployment Checklist

### Security Review

- [ ] All environment variables reviewed
- [ ] Private keys stored in secure secrets manager (not .env)
- [ ] Database credentials validated
- [ ] API keys rotated (Groq AI, Sentry, etc.)
- [ ] JWT_SECRET is 32+ characters
- [ ] No hardcoded secrets in code
- [ ] Firewall rules configured
- [ ] SSL/TLS certificates ready

### Code Review

- [ ] All tests passing: `npm run test:contracts`
- [ ] No console.log in production code
- [ ] Linting passes
- [ ] TypeScript compilation successful
- [ ] Contract security audit completed
- [ ] No TODO/FIXME comments in critical code

### Infrastructure

- [ ] PostgreSQL 14+ running and tested
- [ ] Redis instance running (optional but recommended)
- [ ] Celo RPC endpoint verified
- [ ] Domain DNS configured
- [ ] Load balancer configured (if needed)
- [ ] Backup strategy in place
- [ ] Monitoring tools configured (Sentry, DataDog, etc.)

### Contract Verification

- [ ] Contracts compile without errors
- [ ] All tests passing
- [ ] Gas estimates reviewed
- [ ] No upgrade paths needed
- [ ] Treasury funding plan ready

---

## Environment Setup

### 1. Create Production Environment File

```bash
# Copy template
cp .env.production.template .env.production

# Edit with production values
nano .env.production
```

**Required variables:**

```
NODE_ENV=production
CELO_RPC_URL=https://forno.celo.org
PRIVATE_KEY=0x...          # From secure secrets manager
DATABASE_URL=postgresql://...
FRONTEND_URL=https://questforge.example.com
API_URL=https://api.questforge.example.com
GROQ_API_KEY=sk-...      # From secure secrets manager
JWT_SECRET=...             # Min 32 chars
```

### 2. Validate Production Environment

```bash
# Run validation script
npm run validate:production-env

# Expected output:
# ✓ All environment variables validated
# ✓ RPC connectivity verified
# ✓ Database connection tested
```

### 3. Prepare Deployment Account

```bash
# Generate deployer wallet
node -e "const w = require('ethers').Wallet.createRandom(); console.log('Address:', w.address); console.log('Private Key:', w.privateKey);"

# Fund with CELO for gas
# Send 2-5 CELO to deployer address
# Verify funding:
celocli account:balance 0xYourAddress
```

---

## Step-by-Step Deployment

### Step 1: Validate All Systems

```bash
# Check all prerequisites
npm run validate:production-env

# Build all components
npm run build:all

# Run all tests
npm run test:contracts
```

### Step 2: Deploy Smart Contracts

```bash
# Deploy to Celo Mainnet
npm run deploy:production

# Watch for output:
# ✓ RewardNFT deployed at: 0x...
# ✓ Treasury deployed at: 0x...
# ✓ Reputation deployed at: 0x...
# ✓ ForgeQuestManager deployed at: 0x...
```

**Save the contract addresses** - you'll need them for the backend.

### Step 3: Configure Contract Addresses

Update `.env.production` with deployed addresses:

```bash
FORGE_QUEST_MANAGER_ADDRESS=0xAddress1
REPUTATION_ADDRESS=0xAddress2
REWARD_NFT_ADDRESS=0xAddress3
TREASURY_ADDRESS=0xAddress4
```

### Step 4: Fund Treasury

```bash
# Send initial reward pool to Treasury
# Recommended: 100-500 CELO depending on budget

celocli transfer:dollars \
  --to 0xTreasuryAddress \
  --amount 100 \
  --privateKey 0xYourPrivateKey
```

### Step 5: Validate Treasury

```bash
# Check treasury health
npm run validate:treasury

# Should show:
# ✓ Treasury solvency: SOLVENT
# ✓ Native balance: 100 CELO
# ✓ Payout capability: CAPABLE
```

### Step 6: Start Backend Services

```bash
# In production terminal:
cd backend
npm start

# Wait for output:
# ✓ Connected to Celo Mainnet
# ✓ Database connected
# ✓ Indexer started
# ✓ Verification worker started
# ✓ Server listening on port 4000
```

### Step 7: Start Frontend Services

```bash
# In another terminal:
cd frontend
npm run build && npm start

# Website should be accessible at FRONTEND_URL
```

---

## Validation & Testing

### Complete Validation Suite

Run all validations in order:

```bash
# 1. Environment validation
npm run validate:production-env

# 2. Treasury validation
npm run validate:treasury

# 3. Backend runtime validation
npm run validate:backend-runtime

# 4. End-to-end gameplay (requires running backend)
npm run validate:gameplay

# 5. Security validation
npm run validate:security

# 6. MiniPay validation (requires test mobile device)
npm run validate:minipay
```

### Manual Testing

After automated tests, perform manual testing:

1. **Connect Wallet**
   - Use MiniPay or desktop wallet
   - Verify account shows correct address
   - Check session persists on refresh

2. **Generate Quest**
   - Create multiple quests at different difficulties
   - Verify quest data displayed correctly
   - Check timer accuracy

3. **Complete Quest Flow**
   - Start a quest (TX #1)
   - Verify transaction on explorer
   - Submit proof (TX #2)
   - Wait for verification
   - Receive rewards (TX #3)
   - Check NFT in wallet

4. **Test Error Conditions**
   - Insufficient balance
   - Invalid proof
   - Network switch
   - Session timeout

### Security Testing

Verify security measures:

- [ ] Replay attacks blocked
- [ ] Double rewards prevented
- [ ] Rate limiting active
- [ ] Unauthorized access rejected
- [ ] Input validation working
- [ ] Error messages don't leak info

---

## Post-Deployment Setup

### 1. Monitoring & Alerts

```bash
# Configure Sentry
export SENTRY_DSN=https://...

# Configure DataDog (optional)
export DD_API_KEY=...

# Verify monitoring is active
# Check dashboards show data
```

### 2. Logging Setup

```bash
# Tail production logs
tail -f logs/production.log

# Key metrics to monitor:
# - Request latency
# - Error rates
# - Database connections
# - Contract interactions
```

### 3. Backup Configuration

```bash
# Database backup
pg_dump questforge_prod > backup_$(date +%s).sql

# Automated backups (daily recommended)
# Configure cron job or backup service
```

### 4. SSL Certificate

```bash
# Install Let's Encrypt certificate
certbot certonly --standalone -d api.questforge.example.com

# Renew before expiry
certbot renew
```

### 5. DNS Configuration

```bash
# Point domains to deployed servers
# api.questforge.example.com → backend server IP
# questforge.example.com → frontend server IP

# Verify DNS:
nslookup api.questforge.example.com
```

---

## Monitoring & Maintenance

### Health Checks

```bash
# Monitor health endpoints
while true; do
  curl -s http://localhost:4000/health | jq .
  sleep 30
done
```

### Key Metrics to Track

1. **Backend Health**
   - Response times (target: < 500ms)
   - Error rates (target: < 0.1%)
   - Database pool usage
   - RPC call latency

2. **Contract Health**
   - Transaction success rate
   - Gas usage trends
   - Treasury balance
   - Verification success rate

3. **User Metrics**
   - Active players
   - Quest completion rate
   - Average reward per quest
   - NFT mint rate

### Regular Maintenance

- **Daily:** Check logs for errors
- **Weekly:** Review monitoring dashboards
- **Monthly:** Backup database, rotate secrets
- **Quarterly:** Security audit, update dependencies

---

## Emergency Procedures

### Circuit Breaker Activation

If rewards exceed limits:

```bash
# Contract has automatic circuit breaker
# Check status:
curl -s http://localhost:4000/health/circuit-breaker

# To pause system (if needed):
# Call Treasury.pause() from admin wallet
```

### Database Recovery

```bash
# If database is down:
# 1. Check connectivity
psql -c "SELECT 1"

# 2. Review recent logs
tail -100 logs/postgresql.log

# 3. Restore from backup if necessary
psql questforge_prod < backup_20260510.sql
```

### Contract Emergency

```bash
# If contract behavior is abnormal:
# 1. Check indexer status
curl -s http://localhost:4000/health/indexer

# 2. Review recent transactions
# Check on Celoscan

# 3. Contact Smart Contract Lead
```

---

## Troubleshooting

### Common Issues

#### Backend Won't Start

```bash
# Check database
psql postgresql://user:pass@host/db -c "SELECT 1"

# Check RPC connectivity
curl https://forno.celo.org -X POST -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'

# Check environment variables
npm run validate:production-env
```

#### Transactions Failing

```bash
# Check treasury balance
npm run validate:treasury

# Check contract state
npm run validate:gameplay

# Check gas prices
curl -s https://forno.celo.org -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice"}'
```

#### High Latency

```bash
# Check database connections
select count(*) from pg_stat_activity;

# Check RPC performance
time curl https://forno.celo.org -X POST \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber"}'

# Check network connectivity
ping forno.celo.org
```

#### Memory Leak

```bash
# Monitor memory usage
top -p $(pidof node)

# Check for long-running queries
select * from pg_stat_activity where state = 'active';

# Restart backend if needed
pm2 restart questforge
```

---

## Support & Documentation

- **Smart Contracts:** See [contracts/README.md](../contracts/README.md)
- **Backend API:** See [backend/README.md](../backend/README.md)
- **Frontend:** See [frontend/README.md](../frontend/README.md)
- **Celo Docs:** https://docs.celo.org/
- **Hardhat Docs:** https://hardhat.org/docs
- **Ethers.js:** https://docs.ethers.org/

---

## Deployment Checklist

### Before Going Live

- [ ] All tests passing
- [ ] Environment validated
- [ ] Contracts deployed
- [ ] Treasury funded
- [ ] Backend running
- [ ] Frontend accessible
- [ ] All validation scripts passed
- [ ] Monitoring configured
- [ ] Backups enabled
- [ ] SSL certificates installed
- [ ] DNS configured
- [ ] Team notified
- [ ] Incident response plan ready
- [ ] Rollback procedure documented

### After Going Live

- [ ] Monitor dashboards hourly for 24h
- [ ] Check transaction success rates
- [ ] Monitor error logs
- [ ] Verify user transactions on explorer
- [ ] Gather user feedback
- [ ] Document any issues
- [ ] Plan for optimization if needed

---

## Final Notes

**Congratulations! ForgeQuest Online is now deployed to Celo Mainnet.**

This is a production system serving real users. Please:

1. **Monitor closely** - Check logs and dashboards regularly
2. **Be responsive** - Have on-call support available
3. **Plan updates** - Test thoroughly before deploying changes
4. **Communicate** - Inform users of planned maintenance
5. **Learn continuously** - Review metrics and improve systems

For questions, contact the deployment team or refer to the documentation.

---

**Last Updated:** May 10, 2026  
**Version:** 1.0.0  
**Status:** Production Ready for Celo Mainnet
