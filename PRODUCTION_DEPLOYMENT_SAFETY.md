# 🔐 QuestForge AI – Production Safety & Deployment Verification

**Purpose:** Ensure safe production deployment without breaking existing systems  
**Scope:** Pre-deployment, deployment, and post-deployment validation  
**Audience:** DevOps, QA, Engineering Team

---

## PRE-DEPLOYMENT VALIDATION (24 Hours Before)

### Code Review Checklist

- [ ] All changes reviewed by 2+ senior engineers
- [ ] No unsafe database migrations
- [ ] No contract address changes
- [ ] No wallet flow modifications
- [ ] No proof verification logic changes
- [ ] All tests passing (`npm test`)
- [ ] All linting passing (`npm run lint`)
- [ ] No console.log statements in production code
- [ ] Environment variables documented in .env.example

### Security Audit Checklist

- [ ] No hardcoded secrets in code
- [ ] No SQL injection vulnerabilities
- [ ] No XSS vulnerabilities in frontend
- [ ] Rate limiting properly configured
- [ ] JWT secrets rotated (if applicable)
- [ ] CORS origins whitelist verified
- [ ] HTTPS enforced
- [ ] Helmet security headers active

### Database Checklist

- [ ] All migrations tested on staging
- [ ] Database backup created
- [ ] Prisma client generated (`npm run prisma:generate`)
- [ ] Migration rollback plan documented
- [ ] Data integrity constraints verified
- [ ] Indexes optimized for new queries

### Frontend Checklist

- [ ] Build succeeds without warnings (`npm run build`)
- [ ] All pages load on desktop
- [ ] All pages load on mobile (iPhone 12, Android)
- [ ] Wallet connection tested on MetaMask
- [ ] Wallet connection tested on MiniPay (if available)
- [ ] Network switching tested
- [ ] Transaction modal displays correctly
- [ ] Error messages clear and actionable

### Backend Checklist

- [ ] All environment variables set in production
- [ ] Database connection validated
- [ ] Redis connection validated (if ENABLE_EVENT_STREAM=true)
- [ ] Groq AI API key validated (if GROQ_API_KEY set)
- [ ] RPC endpoint responding
- [ ] Contract addresses accessible
- [ ] Health check endpoint responds
- [ ] No unhandled promise rejections

### Contract Checklist

- [ ] ForgeQuestManager deployed and verified
- [ ] Treasury deployed and verified
- [ ] Reputation deployed and verified
- [ ] RewardNFT deployed and verified
- [ ] All addresses match in .env files
- [ ] Ownership transferred to correct account
- [ ] Circuit breaker tested
- [ ] Pause functionality tested

---

## DEPLOYMENT DAY (Off-Peak Hours Only)

### Pre-Flight (1 Hour Before)

- [ ] All team members notified of deployment
- [ ] Staging environment fully tested
- [ ] Rollback plan documented and practiced
- [ ] Monitoring dashboards open and ready
- [ ] Database backup completed
- [ ] No critical issues in Sentry/error logs
- [ ] Load on systems is low (off-peak)

### Deployment Sequence

**Step 1: Backend Deployment (5 minutes)**

```bash
# On production server
git pull origin main
npm ci
npm run build
npm run prisma:migrate -- deploy
systemctl restart questforge-backend
```

**Step 2: Monitor Backend Health (5 minutes)**

- [ ] Health check responding (`curl https://api.questforge.ai/health`)
- [ ] No 5xx errors in logs
- [ ] Database connections healthy
- [ ] RPC endpoint accessible

**Step 3: Frontend Deployment (5 minutes)**

```bash
# On Vercel/hosting provider
# Usually automatic via git push, or:
vercel deploy --prod
```

**Step 4: Monitor Frontend (5 minutes)**

- [ ] Home page loads
- [ ] Wallet connection works
- [ ] Navigation responsive
- [ ] No console errors (check browser dev tools)

**Step 5: Smoke Test (10 minutes)**

- [ ] Connect wallet
- [ ] Accept test quest
- [ ] Verify quest appears on-chain (check contract)
- [ ] Submit proof URI
- [ ] Check backend processing quest

**Step 6: Communication**

- [ ] Post message in team Slack: "✅ Production deployment complete"
- [ ] Document timestamp and version deployed
- [ ] Notify users of any changes (if applicable)

---

## POST-DEPLOYMENT MONITORING (24 Hours)

### Hour 1-4: Intensive Monitoring

**Monitor Every 15 Minutes:**

- [ ] Error rates < 0.1%
- [ ] Response times normal
- [ ] No database connection errors
- [ ] No authentication failures
- [ ] Transaction success rate > 98%
- [ ] RPC failover not triggering excessively

**Check Logs For:**

- [ ] No unhandled exceptions
- [ ] No SQL errors
- [ ] No gas estimation failures
- [ ] No proof verification errors
- [ ] No treasury balance anomalies

### Hour 4-24: Standard Monitoring

**Every Hour:**

- [ ] Error rate remains < 0.1%
- [ ] At least 10 successful quest completions occurred
- [ ] Wallet connections successful
- [ ] Transactions settled on-chain

**Daily Summary (Next Morning):**

- [ ] Total quests completed: \_\_\_
- [ ] Transaction success rate: \_\_\_%
- [ ] Average response time: \_\_ms
- [ ] Error count: \_\_\_
- [ ] Any user-reported issues: (list)

### Alert Thresholds (Escalate Immediately)

🚨 **CRITICAL - Escalate to on-call engineer:**

- Error rate > 5%
- Database connection failures
- RPC endpoint unreachable
- Treasury insolvent (available liquidity < 1 CELO)
- Proof verification failing > 10%
- Gas estimation failing > 10%

🟠 **HIGH - Investigate within 30 minutes:**

- Error rate > 1%
- Response times > 2x baseline
- Transaction success rate < 95%
- Memory usage > 80%

🟡 **MEDIUM - Investigate within 2 hours:**

- Specific feature errors spike
- Database slow queries detected
- Rate limit triggers on single endpoint

---

## SPECIFIC ROLLBACK PROCEDURES

### If Optimization Changes Cause Issues

**Scenario A: Stake Defaults Too Low**

```bash
# Symptoms: Users report quests are "too easy" or "feel cheap"
# Action:
git revert <commit-hash>
npm run build
npm run prisma:migrate deploy
systemctl restart questforge-backend
# Redeploy frontend
```

**Scenario B: Gas Multiplier Causes Failures**

```bash
# Symptoms: "Gas limit exceeded" errors spike
# Action:
# Revert gas multiplier from 1.1x to 1.2x
# in frontend/src/pages/CommandCenter.tsx
# Rebuild and redeploy frontend
npm run build
vercel deploy --prod
```

**Scenario C: Cache Causes Stale Data**

```bash
# Symptoms: Users report incorrect quest details
# Action:
# Disable cache in metadataCacheService.ts
# Set CACHE_TTL_SECONDS to 0
# Rebuild and restart backend
npm run build
systemctl restart questforge-backend
# Investigate cache invalidation logic
```

**Scenario D: XP Cap Breaks Progression**

```bash
# Symptoms: Players report XP not awarded
# Action:
# Remove XP_PER_QUEST cap temporarily
# Rebuild and restart
npm run build
systemctl restart questforge-backend
# Investigate cap logic
```

**Full Emergency Rollback (Nuclear Option)**

```bash
# If deployment breaks core functionality
git reset --hard HEAD~1
npm run build
npm run prisma:migrate deploy  # Revert DB if needed
systemctl restart questforge-backend
vercel deploy --prod
```

---

## REGRESSION TESTING CHECKLIST

After deployment, verify all existing systems still work:

### Wallet & Auth

- [ ] Connect wallet (MetaMask)
- [ ] Disconnect wallet
- [ ] Sign message works
- [ ] Session persists on refresh
- [ ] Network switch works
- [ ] Wrong network error shows

### Quest Lifecycle

- [ ] Generate quest works
- [ ] Quest accepts properly
- [ ] Stake amount charged
- [ ] Submit proof URI works
- [ ] Proof verification passes
- [ ] Reward payout succeeds
- [ ] NFT mints correctly
- [ ] Quest appears in history

### User Profile

- [ ] XP increments
- [ ] Level progression correct
- [ ] Streak counts
- [ ] Cooldown enforced
- [ ] Daily cap respected
- [ ] Achievements unlock

### Leaderboard

- [ ] Leaderboard loads
- [ ] Rankings update
- [ ] Filters work (if applicable)
- [ ] Pagination works

### Realtime Features

- [ ] Quest updates appear in real-time
- [ ] WebSocket connected
- [ ] Notifications display
- [ ] Feed updates

### Error Scenarios

- [ ] Quest expiration handled
- [ ] Insufficient stake rejected
- [ ] Invalid proof detected
- [ ] Treasury insolvency error shows
- [ ] RPC error gracefully handled
- [ ] Rate limit respected

---

## PERFORMANCE VALIDATION

### Before Deployment

```
Baseline Metrics (capture on staging):
- Quest generation latency: __ms
- Proof submission latency: __ms
- Leaderboard page load: __ms
- Average RPC latency: __ms
- Database query p95: __ms
```

### After Deployment

```
Post-Deployment Metrics (capture on production):
- Quest generation latency: __ms (should be ≤ baseline)
- Proof submission latency: __ms (should be ≤ baseline)
- Leaderboard page load: __ms (should be ≤ baseline)
- Average RPC latency: __ms (should be ≤ baseline)
- Database query p95: __ms (should be ≤ baseline)
```

**Accept if:** All metrics within 10% of baseline or improved

---

## STAKEHOLDER COMMUNICATION TEMPLATES

### Pre-Deployment Notification

```
🚀 SCHEDULED MAINTENANCE

Date: [DATE] [TIME] UTC
Expected Duration: 15-30 minutes
Impact: Brief service interruption possible

What's changing:
- Transaction cost optimization
- UI improvements
- Performance enhancements

No user action required. Your data and wallets are safe.

Questions? Contact: [support email]
```

### Deployment Success Notification

```
✅ DEPLOYMENT COMPLETE

All systems operational and healthy.
- Transaction costs optimized
- UI improvements deployed
- Performance enhanced

Thank you for your patience!
```

### Emergency Rollback Notification (If Needed)

```
⚠️ ROLLBACK IN PROGRESS

We identified an issue and are reverting recent changes.
- Current status: Rolling back
- ETA for normal service: [TIME]
- Your data is safe
- No action required

We'll follow up with full details.
```

---

## 24-HOUR POST-DEPLOYMENT SIGN-OFF

After 24 hours of monitoring, complete this sign-off:

**Deployment Date:** **\*\***\_\_\_**\*\***  
**Deployed By:** **\*\***\_\_\_**\*\***  
**Reviewed By:** **\*\***\_\_\_**\*\***

### All Systems Healthy?

- [ ] YES - Proceed with normal operations
- [ ] NO - Document issues and remediate

### Any Critical Issues?

- [ ] No critical issues
- [ ] Issues found: \***\*\_\_\*\*** (describe and action)

### User Feedback?

- [ ] No user reports
- [ ] User feedback: \***\*\_\_\*\*** (summarize)

### Performance?

- [ ] Within expected baseline
- [ ] Degradation: \***\*\_\_\*\*** (describe)

### Ready for Next Deployment?

- [ ] YES - Can deploy related changes
- [ ] NO - Wait 48 hours; investigate issues first

**Sign-Off:** **\*\***\_\_\_**\*\***  
**Date/Time:** **\*\***\_\_\_**\*\***

---

## CONTINUOUS MONITORING (Weekly)

Every week after deployment:

- [ ] Transaction success rate stable > 98%
- [ ] Error rates remain < 0.1%
- [ ] No concerning Sentry issues
- [ ] Database performance healthy
- [ ] RPC endpoints responsive
- [ ] Treasury healthy
- [ ] User engagement metrics normal
- [ ] No customer complaints

If any metric anomalies detected, investigate and create ticket.

---

## DEPLOYMENT HISTORY LOG

| Date   | Version | Changes            | Status | Issues |
| ------ | ------- | ------------------ | ------ | ------ |
| [DATE] | 1.0.0   | Initial production | ✅     | None   |
|        |         |                    |        |        |
|        |         |                    |        |        |

---

## QUICK REFERENCE

**Emergency Contacts:**

- Backend On-Call: [PHONE]
- Frontend On-Call: [PHONE]
- DevOps On-Call: [PHONE]
- Infrastructure Slack: #questforge-ops

**Important URLs:**

- Production API: https://api.questforge.ai
- Production Frontend: https://questforge.ai
- Health Check: https://api.questforge.ai/health
- Sentry Dashboard: [URL]
- Database Dashboard: [URL]
- RPC Monitor: [URL]

**Key Files:**

- Backend .env: /var/questforge/backend/.env
- Frontend .env: /var/questforge/frontend/.env
- Database backups: /backups/questforge/
- Log files: /var/log/questforge/

---

**Document Version:** 1.0  
**Last Updated:** May 24, 2026  
**Next Review:** June 1, 2026  
**Approval:** Architecture Team
