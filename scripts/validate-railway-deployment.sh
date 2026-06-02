#!/bin/bash

# QuestForge AI - Railway Deployment Validation Script
# This script validates that all required components are properly deployed and configured

set -e

echo "╔════════════════════════════════════════════════════════════╗"
echo "║    QuestForge AI - Railway Production Deployment Check     ║"
echo "║                    May 24, 2026                            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

PASSED=0
FAILED=0
WARNINGS=0

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

check_pass() {
  echo -e "${GREEN}✓${NC} $1"
  ((PASSED++))
}

check_fail() {
  echo -e "${RED}✗${NC} $1"
  ((FAILED++))
}

check_warn() {
  echo -e "${YELLOW}⚠${NC} $1"
  ((WARNINGS++))
}

echo "1. ENVIRONMENT VALIDATION"
echo "=========================="

# Check critical environment variables
if [ -z "$DATABASE_URL" ]; then
  check_fail "DATABASE_URL not set"
else
  check_pass "DATABASE_URL configured"
fi

if [ -z "$CELO_RPC_URL" ]; then
  check_fail "CELO_RPC_URL not set"
else
  check_pass "CELO_RPC_URL configured"
fi

if [ -z "$JWT_SECRET" ]; then
  check_fail "JWT_SECRET not set"
else
  if [ ${#JWT_SECRET} -ge 32 ]; then
    check_pass "JWT_SECRET is sufficiently long (${#JWT_SECRET} chars)"
  else
    check_fail "JWT_SECRET is too short (${#JWT_SECRET} chars, need 32+)"
  fi
fi

# Check contract addresses
if [ -z "$FORGE_QUEST_MANAGER_ADDRESS" ]; then
  check_fail "FORGE_QUEST_MANAGER_ADDRESS not set"
else
  check_pass "FORGE_QUEST_MANAGER_ADDRESS = $FORGE_QUEST_MANAGER_ADDRESS"
fi

if [ -z "$REPUTATION_ADDRESS" ]; then
  check_fail "REPUTATION_ADDRESS not set"
else
  check_pass "REPUTATION_ADDRESS = $REPUTATION_ADDRESS"
fi

if [ -z "$REWARD_NFT_ADDRESS" ]; then
  check_fail "REWARD_NFT_ADDRESS not set"
else
  check_pass "REWARD_NFT_ADDRESS = $REWARD_NFT_ADDRESS"
fi

if [ -z "$TREASURY_ADDRESS" ]; then
  check_fail "TREASURY_ADDRESS not set"
else
  check_pass "TREASURY_ADDRESS = $TREASURY_ADDRESS"
fi

echo ""
echo "2. DATABASE MIGRATION CHECK"
echo "============================"

if [ ! -f "prisma/schema.prisma" ]; then
  check_fail "prisma/schema.prisma not found"
else
  check_pass "Prisma schema found"
  
  # Check if critical tables are in schema
  if grep -q "model WorldEvent" prisma/schema.prisma; then
    check_pass "WorldEvent model defined in schema"
  else
    check_fail "WorldEvent model missing from schema"
  fi
  
  if grep -q "model WorldStateSnapshot" prisma/schema.prisma; then
    check_pass "WorldStateSnapshot model defined in schema"
  else
    check_fail "WorldStateSnapshot model missing from schema"
  fi
  
  if grep -q "model Quest" prisma/schema.prisma; then
    check_pass "Quest model defined in schema"
  else
    check_fail "Quest model missing from schema"
  fi
fi

echo ""
echo "3. DEPLOYMENT CONFIGURATION"
echo "==========================="

if [ "$NODE_ENV" = "production" ]; then
  check_pass "NODE_ENV = production"
else
  check_warn "NODE_ENV is not set to production (current: $NODE_ENV)"
fi

if [ "$CELO_CHAIN_ID" = "42220" ]; then
  check_pass "Celo Mainnet configured (Chain ID: 42220)"
else
  check_fail "Incorrect chain ID: $CELO_CHAIN_ID (expected 42220)"
fi

echo ""
echo "4. SERVICE STATUS"
echo "=================="

# These checks are informational
echo "Optional services configuration:"
if [ "$WEBSOCKET_ENABLED" = "true" ] || [ -z "$WEBSOCKET_ENABLED" ]; then
  check_pass "WebSocket enabled"
else
  check_warn "WebSocket disabled"
fi

if [ "$ENABLE_EVENT_STREAM" = "true" ]; then
  if [ -z "$REDIS_URL" ]; then
    check_fail "REDIS_URL required when ENABLE_EVENT_STREAM=true"
  else
    check_pass "Event streaming enabled with Redis"
  fi
else
  check_warn "Event streaming disabled (ENABLE_EVENT_STREAM not set to true)"
fi

if [ -n "$GROQ_API_KEY" ]; then
  check_pass "Groq API configured"
else
  check_warn "Groq API not configured (deterministic fallback quests enabled)"
fi

if [ -n "$GROQ_MODEL" ]; then
  check_pass "Groq model configured: $GROQ_MODEL"
else
  check_warn "GROQ_MODEL not set (backend defaults to llama-3.3-70b-versatile)"
fi

echo ""
echo "5. BLOCKCHAIN CONFIGURATION"
echo "============================"

if [ "$CELO_RPC_URL" = "https://forno.celo.org" ]; then
  check_pass "Using public Celo RPC endpoint"
else
  check_warn "Using custom RPC endpoint: $CELO_RPC_URL"
fi

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                     VALIDATION SUMMARY                     ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo -e "Passed:   ${GREEN}${PASSED}${NC}"
echo -e "Failed:   ${RED}${FAILED}${NC}"
echo -e "Warnings: ${YELLOW}${WARNINGS}${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ All critical checks passed!${NC}"
  echo ""
  echo "Next steps:"
  echo "1. Ensure migrations have been applied: npm run prisma:migrate:deploy"
  echo "2. Monitor the application logs for startup issues"
  echo "3. Test API endpoints: GET /health, GET /health/ready"
  echo "4. Verify database connectivity and schema"
  exit 0
else
  echo -e "${RED}✗ Critical validation failures detected${NC}"
  echo ""
  echo "Required fixes:"
  echo "1. Set all missing environment variables in Railway dashboard"
  echo "2. Verify DATABASE_URL points to the correct PostgreSQL instance"
  echo "3. Ensure contract addresses are correct for Celo Mainnet"
  exit 1
fi
