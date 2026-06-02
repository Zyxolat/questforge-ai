# QuestForge AI - Production Deployment Guide

**Target Network:** Celo (mainnet)  
**Last Updated:** 2026-05-09  
**Deployment Status:** Ready for Production

---

## Table of Contents

1. [Pre-Deployment Checklist](#pre-deployment-checklist)
2. [Smart Contract Deployment](#smart-contract-deployment)
3. [Database Setup](#database-setup)
4. [Backend Deployment](#backend-deployment)
5. [Frontend Deployment](#frontend-deployment)
6. [Post-Deployment Verification](#post-deployment-verification)
7. [Monitoring & Alerts](#monitoring--alerts)
8. [Troubleshooting](#troubleshooting)
9. [Rollback Procedures](#rollback-procedures)

---

## Pre-Deployment Checklist

### Environment Preparation

- [ ] Celo mainnet RPC endpoint secured (https://forno.celo.org)
- [ ] PostgreSQL 14+ instance provisioned and tested
- [ ] Redis instance running (for rate limiting)
- [ ] Domain DNS configured for API and Frontend
- [ ] SSL/TLS certificates installed
- [ ] Monitoring tools configured (Sentry, DataDog, etc.)

### Security Verification

- [ ] Private key stored in secure secrets manager (not in .env)
- [ ] Database credentials not in version control
- [ ] API keys (Groq AI) rotated recently
- [ ] JWT_SECRET is 32+ characters
- [ ] All environment variables reviewed
- [ ] Firewall rules configured (only necessary ports open)

### Code Review

- [ ] All tests passing: `npm test`
- [ ] No console.log in production code
- [ ] No hardcoded secrets or API keys
- [ ] Linting passes: `npm run lint`
- [ ] TypeScript compilation successful: `npm run build`

### Contract Verification

- [ ] Smart contracts compiled successfully
- [ ] Tests passing: `npm test` (contracts)
- [ ] Gas estimates reviewed
- [ ] Deployment script tested against Celo Mainnet configuration
- [ ] Contract addresses ready
- [ ] Treasury funded with initial rewards

---

## Smart Contract Deployment

### Step 1: Deploy on Celo Mainnet

```bash
cd contracts
npm install

# Compile
npm run compile

# Test
npm run test

# Deploy to Celo Mainnet
npm run deploy:mainnet

# Validate deployed contracts and roles
npm run validate:mainnet

# Record deployed addresses
# FORGE_QUEST_MANAGER_ADDRESS=0x...
# REPUTATION_ADDRESS=0x...
# REWARD_NFT_ADDRESS=0x...
# TREASURY_ADDRESS=0x...
```

### Step 2: Verify Contracts

```bash
# Verify on Celo Explorer
# https://celoscan.io/

# Save addresses to .env.production:
FORGE_QUEST_MANAGER_ADDRESS=0x...
REPUTATION_ADDRESS=0x...
REWARD_NFT_ADDRESS=0x...
TREASURY_ADDRESS=0x...
```

### Step 3: Fund Treasury

```bash
# Send initial reward pool to Treasury contract
# Example: 100 CELO
celocli transfer:dollars \
  --to TREASURY_ADDRESS \
  --amount 100
```

### Step 4: Grant Roles

```bash
# Grant MINTER_ROLE to ForgeQuestManager
# Grant REWARD_ROLE to ForgeQuestManager
# Grant VERIFIER_ROLE to backend service address

# Use verification script or Celo CLI
```

---

## Database Setup

### Step 1: Create PostgreSQL Database

```bash
# Connect to PostgreSQL server
psql -U postgres

# Create database
CREATE DATABASE questforge_prod;
CREATE USER questforge WITH PASSWORD 'secure_password_here';
ALTER ROLE questforge SET client_encoding TO 'utf8mb4';
ALTER ROLE questforge SET default_transaction_isolation TO 'read committed';
ALTER ROLE questforge SET default_transaction_deferrable TO on;
ALTER ROLE questforge SET default_timezone TO 'UTC';
GRANT ALL PRIVILEGES ON DATABASE questforge_prod TO questforge;

# Exit psql
\q
```

### Step 2: Set DATABASE_URL

```bash
export DATABASE_URL="postgresql://questforge:password@db.host:5432/questforge_prod"
```

### Step 3: Run Prisma Migrations

```bash
cd backend

# Install dependencies
npm install

# Generate Prisma client
npm run prisma:generate

# Deploy migrations
npx prisma migrate deploy

# Verify schema
npx prisma db pull
```

### Step 4: Create Indexes for Performance

```bash
# Manually create additional indexes for hot queries
psql -U questforge -d questforge_prod -f database-indexes.sql
```

### Step 5: Backup Procedure

```bash
# Setup daily backups
pg_dump -U questforge questforge_prod | gzip > /backups/questforge_prod_$(date +%Y%m%d).sql.gz

# Store in cloud (S3, GCS, etc.)
# Retention: 30 days
```

---

## Backend Deployment

### Step 1: Build Backend

```bash
cd backend

# Install dependencies
npm install

# Build TypeScript
npm run build

# Verify build
ls dist/
```

### Step 2: Create .env.production

```bash
# Copy template
cp .env.production.template .env.production

# Fill in all values from checklist above
vim .env.production

# Verify no secrets in version control
git status
```

### Step 3: Deploy to Production Server

```bash
# Option A: Docker (Recommended)
docker build -t questforge-backend:latest .
docker push your-registry/questforge-backend:latest

# Option B: Direct deployment
scp -r dist/ user@server:/app/backend/
scp .env.production user@server:/app/backend/
```

### Step 4: Start Backend Service

```bash
# Via systemd (recommended)
sudo systemctl start questforge-backend
sudo systemctl status questforge-backend

# Or via Docker
docker run -d \
  --name questforge-backend \
  -p 4000:4000 \
  --env-file .env.production \
  questforge-backend:latest

# Check logs
docker logs -f questforge-backend
```

### Step 5: Verify Backend is Running

```bash
# Health check
curl https://api.questforge.example.com/health

# Expected response:
# {
#   "status": "ok",
#   "checks": {
#     "database": true,
#     "blockchain": true,
#     "api": true,
#     "memory": true
#   },
#   "timestamp": "2026-05-09T10:00:00Z"
# }
```

---

## Frontend Deployment

### Step 1: Build Frontend

```bash
cd frontend

# Install dependencies
npm install

# Build for production
npm run build

# Verify build output
ls dist/
```

### Step 2: Configure API Endpoint

```bash
# Update environment variable before build
export VITE_API_URL=https://api.questforge.example.com
npm run build
```

### Step 3: Deploy to CDN

```bash
# Option A: Vercel
vercel deploy --prod

# Option B: AWS S3 + CloudFront
aws s3 sync dist/ s3://questforge-frontend-prod/
aws cloudfront create-invalidation --distribution-id XXXX --paths "/*"

# Option C: Traditional web server
scp -r dist/* user@server:/var/www/questforge/
```

### Step 4: Verify Frontend is Accessible

```bash
# Check website
https://questforge.example.com

# Verify API connectivity
# Open DevTools Console and test
fetch('https://api.questforge.example.com/health')
```

---

## Post-Deployment Verification

### Step 1: Smoke Tests

```bash
# Test authentication
curl -X POST https://api.questforge.example.com/auth/nonce \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0x...", "chainId":42220}'

# Expected: 200 OK with nonce

# Test quest generation (need valid JWT)
curl -X POST https://api.questforge.example.com/quests/generate \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chain":"Celo"}'

# Expected: 200 OK with quest data
```

### Step 2: Database Verification

```bash
# Check schema
psql -U questforge -d questforge_prod -c "\dt"

# Check row counts
psql -U questforge -d questforge_prod -c "SELECT COUNT(*) FROM \"User\";"

# Check indexes
psql -U questforge -d questforge_prod -c "\di"
```

### Step 3: Blockchain Verification

```bash
# Check contract state
# Use ethers.js or Celo CLI to verify

# Read quest count
celocli call ForgeQuestManager nextQuestId

# Read treasury balance
celocli balance TREASURY_ADDRESS
```

### Step 4: Indexer Verification

```bash
# Check indexer state in DB
psql -U questforge -d questforge_prod -c "SELECT * FROM indexer_state;"

# Verify recent events synced
psql -U questforge -d questforge_prod -c "SELECT * FROM processed_chain_events ORDER BY created_at DESC LIMIT 5;"

# Check lag
# Should be <60 seconds behind chain tip
```

### Step 5: Monitor Initial Traffic

```bash
# Watch logs
tail -f /var/log/questforge-backend.log

# Monitor errors
grep ERROR /var/log/questforge-backend.log

# Check rate limiting
grep "Too many requests" /var/log/questforge-backend.log
```

---

## Monitoring & Alerts

### Logging Setup (Sentry/DataDog)

```typescript
// In backend/src/index.ts
import Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: "production",
  tracesSampleRate: 0.1,
});

app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.errorHandler());
```

### Metrics to Monitor

1. **API Performance**
   - Response time (p50, p95, p99)
   - Error rate
   - Requests per second
   - Rate limit violations

2. **Database**
   - Connection pool usage
   - Query performance
   - Replication lag
   - Backup status

3. **Blockchain**
   - RPC response time
   - Transaction confirmation time
   - Indexer lag
   - Circuit breaker status

4. **Business Metrics**
   - Daily active wallets
   - Quest completion rate
   - Average rewards distributed
   - Player retention

### Alert Rules

```yaml
AlertRules:
  - Name: HighErrorRate
    Condition: error_rate > 5%
    Action: Page oncall engineer
    Severity: Critical

  - Name: SlowAPIResponse
    Condition: response_time_p95 > 1000ms
    Action: Alert to Slack
    Severity: Warning

  - Name: DBConnectionPoolExhausted
    Condition: db_pool_usage > 90%
    Action: Page oncall engineer
    Severity: Critical

  - Name: CircuitBreakerTriggered
    Condition: reward_system_healthy == false
    Action: Page oncall engineer + broadcast announcement
    Severity: Critical

  - Name: IndexerLag
    Condition: indexer_lag_seconds > 300
    Action: Alert to Slack
    Severity: High
```

---

## Troubleshooting

### Issue: High Error Rate After Deployment

**Symptoms:** API returning 500 errors

**Solutions:**

1. Check logs: `tail -f /var/log/questforge-backend.log`
2. Verify environment variables: `printenv | grep QUEST`
3. Check database connection: `psql -U questforge -d questforge_prod -c "SELECT 1"`
4. Verify contract addresses: Deploy script output
5. Restart backend: `systemctl restart questforge-backend`

### Issue: Database Migration Failed

**Symptoms:** "migration pending" error

**Solutions:**

1. Check migration status: `npx prisma migrate status`
2. View migration logs: `npx prisma migrate resolve --rolled-back <migration_name>`
3. Manual rollback if needed: `psql -f rollback.sql`
4. Re-run migrations: `npx prisma migrate deploy`

### Issue: Rate Limiting Too Strict

**Symptoms:** Legitimate users getting 429 errors

**Solutions:**

1. Check Redis: `redis-cli ping`
2. Adjust limits in .env: `QUEST_GENERATION_RATE_LIMIT=100`
3. Whitelist high-value players (optional)
4. Monitor rate limit headers: `curl -v | grep RateLimit`

### Issue: Indexer Not Syncing

**Symptoms:** Quests created but not appearing in DB

**Solutions:**

1. Check indexer logs: `grep -i "indexer" /var/log/questforge-backend.log`
2. Verify RPC connection: `curl https://forno.celo.org -X POST`
3. Check last processed block: `psql -c "SELECT * FROM indexer_state"`
4. Restart indexer: `systemctl restart questforge-backend`

### Issue: Out of Memory

**Symptoms:** Backend crashes with OOM

**Solutions:**

1. Increase Node.js heap: `NODE_OPTIONS=--max_old_space_size=2048`
2. Check memory leaks: `node --inspect dist/index.js`
3. Enable clustering for multi-core
4. Check database connection pool size: `DB_POOL_SIZE=10`

---

## Rollback Procedures

### Scenario 1: Backend Rollback

```bash
# Revert to previous version
git checkout previous-commit
npm install
npm run build

# Stop current service
systemctl stop questforge-backend

# Restore from backup
docker pull questforge-backend:previous-tag
docker run -d --name questforge-backend questforge-backend:previous-tag

# Verify
curl https://api.questforge.example.com/health
```

### Scenario 2: Database Rollback

```bash
# Stop backend to prevent writes
systemctl stop questforge-backend

# Restore from backup
psql -U questforge questforge_prod < /backups/questforge_prod_$(date -d "1 day ago" +%Y%m%d).sql.gz

# Restart backend
systemctl start questforge-backend

# Verify data integrity
psql -U questforge -d questforge_prod -c "SELECT COUNT(*) FROM \"Quest\";"
```

### Scenario 3: Contract Rollback

**Note: Smart contracts cannot be directly rolled back**

Options:

1. Redeploy previous contract version at new address
2. Update environment variables to point to old contract
3. Use proxy pattern (UUPS) for future upgrades
4. Announce maintenance window

---

## Post-Launch Maintenance

### Daily Tasks

- Monitor error logs
- Check health endpoints
- Verify database backups

### Weekly Tasks

- Review performance metrics
- Check security logs
- Test disaster recovery

### Monthly Tasks

- Review rate limit effectiveness
- Audit contract state
- Update dependencies
- Security audit

### Quarterly Tasks

- Full security audit
- Load testing
- Disaster recovery drill
- Stakeholder review

---

## Support & Escalation

### On-Call Engineer Escalation

1. **Severity 1 (Critical):** Page oncall immediately
   - Service down
   - Circuit breaker triggered
   - Data loss detected

2. **Severity 2 (High):** Alert Slack + schedule meeting
   - High error rate (>5%)
   - Significant performance degradation
   - Security concern

3. **Severity 3 (Medium):** Slack notification
   - Elevated error rate (1-5%)
   - Minor performance issue
   - Feature bug

4. **Severity 4 (Low):** Log ticket
   - Information
   - Improvement suggestion

### Contact Information

- **On-Call:** ops-oncall@questforge.example.com
- **Security:** security@questforge.example.com
- **Engineering:** engineering@questforge.example.com

---

## Success Criteria

✅ All health checks passing  
✅ API response time <500ms p95  
✅ Error rate <1%  
✅ Database replication lag <5s  
✅ Indexer lag <60s  
✅ 100+ daily active wallets  
✅ >60% quest completion rate  
✅ No critical security issues  
✅ All rate limits enforced  
✅ Circuit breaker operational

---

**Deployment Approved By:** Engineering Lead  
**Date:** 2026-05-09  
**Version:** 1.0.0
