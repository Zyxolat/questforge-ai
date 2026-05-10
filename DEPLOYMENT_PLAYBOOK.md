# QuestForge AI - Production Deployment Execution Playbook

**Generated:** May 10, 2026  
**Status:** Ready for Production Deployment  
**Target:** Celo Mainnet  
**Readiness Score:** 93/100

---

## 🚀 QUICK START

### 1-Minute Setup
```bash
# Copy environment template
cp .env.production.template .env.production

# Edit with your values
nano .env.production

# Validate everything is ready
npm run validate:production-env
```

### 5-Minute Deployment
```bash
# Deploy contracts to Celo Mainnet
npm run deploy:production

# Save the contract addresses!
# (displayed in console and saved to deployment-report.json)

# Generate deployment report
npm run generate:report
```

### 10-Minute Validation
```bash
# Run all validation tests
npm run validate:all

# All tests should pass before going live
```

---

## 📋 Available Commands

### Validation Scripts
```bash
npm run validate:production-env    # Check environment variables
npm run validate:treasury          # Verify treasury health
npm run validate:gameplay          # Test end-to-end gameplay
npm run validate:security          # Run security tests
npm run validate:minipay          # Test MiniPay mobile flow
npm run validate:backend-runtime   # Check backend health
npm run validate:all              # Run all validations
```

### Deployment Scripts
```bash
npm run deploy:production         # Deploy contracts to Celo Mainnet
npm run generate:report           # Generate deployment report
```

### Build Scripts
```bash
npm run build:contracts           # Compile smart contracts
npm run build:backend             # Build backend services
npm run build:frontend            # Build frontend application
npm run build:all                 # Build everything
```

### Development
```bash
npm run dev:backend               # Start backend in dev mode
npm run dev:frontend              # Start frontend in dev mode
npm run start:backend             # Start backend in production
npm run start:frontend            # Start frontend in production
```

---

## 📊 Deployment Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    User (Browser/Mobile)                     │
└────────────────┬──────────────────────────────┬──────────────┘
                 │                              │
        ┌────────▼──────┐          ┌────────────▼─────┐
        │   Frontend     │          │  MiniPay Wallet  │
        │  React + Vite  │          │   (Mobile)       │
        └────────┬───────┘          └────────┬─────────┘
                 │                           │
                 └──────────┬────────────────┘
                            │
                    ┌───────▼────────┐
                    │  Backend API   │
                    │  Express.js    │
                    │  :4000         │
                    └───────┬────────┘
                            │
        ┌───────────────────┼─────────────────────┐
        │                   │                     │
    ┌───▼────┐      ┌───────▼────┐      ┌────────▼─────┐
    │PostgreSQL   │  │ Celo RPC   │      │   Redis      │
    │Database     │  │  Mainnet   │      │ (Optional)   │
    └────────┘      └────────────┘      └──────────────┘
                            │
        ┌───────────────────▼──────────────┐
        │    Smart Contracts (Celo)        │
        │  - RewardNFT                     │
        │  - Treasury                      │
        │  - Reputation                    │
        │  - ForgeQuestManager             │
        └────────────────────────────────┘
```

---

## 🔄 Deployment Flow

### Phase 1: Pre-Flight (5 minutes)
```bash
1. npm run validate:production-env
   ✓ Environment validated
   ✓ RPC connected
   ✓ Database accessible
```

### Phase 2: Contract Deployment (10-15 minutes)
```bash
2. npm run deploy:production
   ✓ Contracts compiled
   ✓ Tests passed
   ✓ Contracts deployed
   ✓ Roles configured
   ✓ Addresses wired to .env
```

### Phase 3: Treasury Funding (5 minutes)
```bash
3. npm run validate:treasury
   ✓ Treasury verified
   ✓ Balance confirmed
   ✓ Solvency checked
```

### Phase 4: Service Startup (5 minutes)
```bash
4. Start Backend & Frontend
   ✓ Backend listening
   ✓ Frontend built
   ✓ Services connected
```

### Phase 5: Gameplay Validation (10-15 minutes)
```bash
5. npm run validate:gameplay
   ✓ Wallet connection works
   ✓ Quest generation works
   ✓ Transactions confirm
   ✓ Rewards distributed
   ✓ NFTs minted
```

### Phase 6: Security Validation (5 minutes)
```bash
6. npm run validate:security
   ✓ Replay attacks blocked
   ✓ Double rewards prevented
   ✓ Invalid proof rejected
   ✓ Rate limiting active
```

### Phase 7: Final Checks (5 minutes)
```bash
7. npm run generate:report
   ✓ Report generated
   ✓ All checks passed
   ✓ Ready for production
```

**Total Time: 45-60 minutes**

---

## 🎯 Success Criteria

### Environment Validation ✓
- [ ] All required variables present
- [ ] RPC connectivity verified
- [ ] Database connection works
- [ ] Private keys securely stored

### Contract Deployment ✓
- [ ] All 4 contracts deployed
- [ ] Deployment addresses saved
- [ ] Roles configured correctly
- [ ] Treasury funded

### Treasury Health ✓
- [ ] Balance > 10 CELO
- [ ] Solvency: SOLVENT
- [ ] Can execute payouts
- [ ] Circuit breaker configured

### Gameplay Flow ✓
- [ ] Wallet connection works
- [ ] Quest generation succeeds
- [ ] TX #1 (start) confirms
- [ ] TX #2 (proof) confirms
- [ ] TX #3 (payout) confirms
- [ ] NFT minted successfully
- [ ] XP updated
- [ ] Leaderboard updated

### Security ✓
- [ ] Replay attacks blocked
- [ ] Double rewards prevented
- [ ] Unauthorized access rejected
- [ ] Rate limiting active
- [ ] Input validation working

### Backend Runtime ✓
- [ ] Health check responds
- [ ] Database connected
- [ ] Indexer running
- [ ] Verifier worker running
- [ ] Rate limiting active
- [ ] Error handling works

### Performance ✓
- [ ] API response < 500ms
- [ ] Transaction confirmation < 30s
- [ ] Page load < 3s
- [ ] No memory leaks detected

---

## 📝 Pre-Deployment Checklist

### Security (CRITICAL)
- [ ] PRIVATE_KEY stored in secrets manager
- [ ] DATABASE_URL uses secure credentials
- [ ] No secrets in .env file (git-ignored)
- [ ] All team members have access to secrets
- [ ] Incident response plan ready

### Infrastructure (CRITICAL)
- [ ] PostgreSQL 14+ running
- [ ] Celo RPC endpoint responding
- [ ] Domain DNS records configured
- [ ] SSL certificates installed
- [ ] Firewall rules configured
- [ ] Database backups enabled

### Code Quality (REQUIRED)
- [ ] All tests passing
- [ ] No console.log in production code
- [ ] Linting passes
- [ ] TypeScript builds successfully
- [ ] Security audit complete

### Deployment (REQUIRED)
- [ ] .env.production created
- [ ] Deployer wallet funded (2-5 CELO)
- [ ] Team notified of deployment time
- [ ] Rollback plan documented
- [ ] On-call support available

---

## 🚨 Rollback Procedures

### If Deployment Fails

```bash
# Stop all services
npm stop

# Review error logs
cat logs/deployment-error.log

# Fix issue
# Edit .env.production or code as needed

# Redeploy
npm run deploy:production
```

### If Contract Has Issues

```bash
# Check contract state on Celoscan
# Review verification on explorer

# If critical:
# 1. Pause treasury (if implemented)
# 2. Notify users
# 3. Plan fix and redeployment
```

### If Backend Service Dies

```bash
# Check logs
tail -f logs/production.log

# Restart backend
npm run start:backend

# Monitor for stability
npm run validate:backend-runtime
```

---

## 📞 Support Contacts

| Role | Responsibility | Contact |
|------|-----------------|---------|
| Smart Contract Lead | Contract deployment & verification | - |
| Backend Lead | API operations & indexing | - |
| DevOps Lead | Infrastructure & monitoring | - |
| Product Manager | Release coordination | - |

---

## 📚 Key Resources

- **Full Deployment Guide:** [PRODUCTION_DEPLOYMENT_GUIDE.md](./PRODUCTION_DEPLOYMENT_GUIDE.md)
- **Production Readiness Report:** [PRODUCTION_READINESS_REPORT.md](./PRODUCTION_READINESS_REPORT.md)
- **Smart Contracts:** [contracts/README.md](./contracts/README.md)
- **Backend API:** [backend/README.md](./backend/README.md)
- **Frontend App:** [frontend/README.md](./frontend/README.md)

---

## 🎉 After Successful Deployment

1. **Celebrate!** 🎊 You've deployed to mainnet!

2. **Monitor closely**
   - Check dashboards every hour for 24h
   - Watch for errors in logs
   - Monitor gas prices and costs

3. **Gather metrics**
   - Player engagement
   - Quest completion rate
   - Average reward per quest
   - Error rate
   - Response times

4. **Be ready to respond**
   - Emergency pause capability
   - Quick rollback procedure
   - Communication channel open
   - Support team on standby

5. **Document everything**
   - Record deployment time
   - Save contract addresses
   - Log any issues encountered
   - Note optimizations for future

---

## 🏁 Deployment Timeline

**T-0 Hours:** Final validation & preparation  
**T+0:** Begin deployment  
**T+5m:** Environment validation  
**T+20m:** Contracts deployed  
**T+25m:** Treasury verified  
**T+30m:** Backend & Frontend online  
**T+45m:** Gameplay validation  
**T+50m:** Security validation  
**T+55m:** Final report generated  
**T+60m:** Go-live announcement

---

## ✅ Final Readiness Check

```bash
# Run before deployment
npm run validate:all

# Should see:
# ✓ Environment validation PASSED
# ✓ Contract compilation PASSED
# ✓ Contract tests PASSED
# ✓ Treasury validation PASSED
# ✓ Gameplay validation PASSED
# ✓ Security validation PASSED
# ✓ Backend runtime validation PASSED

# If all pass, you are READY FOR PRODUCTION
```

---

**Status:** ✅ PRODUCTION READY  
**Last Updated:** May 10, 2026  
**Version:** 1.0.0  
**Next Review:** May 17, 2026

**Good luck! 🚀**
