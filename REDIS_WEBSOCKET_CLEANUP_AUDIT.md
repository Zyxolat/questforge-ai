# 🔴 REDIS & WEBSOCKET CLEANUP: PRE-DELETION AUDIT

**Status**: READY FOR CONFIRMATION  
**Action**: Destructive (will delete 9 service files + update 5 config files + remove 8 dependencies)  
**Risk Level**: LOW (only cleanup, no breaking changes to database-first model)  
**Rollback**: Easy (git restore)

---

## 📊 DELETION SUMMARY

| Category                            | Count | Impact                   |
| ----------------------------------- | ----- | ------------------------ |
| **Service Files to Delete**         | 9     | ~2,500 lines of code     |
| **Config Files to Update**          | 5     | ~20 lines to remove      |
| **Dependencies to Remove**          | 8     | ~150MB from node_modules |
| **Environment Variables to Remove** | 8     | Simplify configuration   |
| **Imports to Remove**               | 15+   | Clean up service imports |

---

## 🗑️ SECTION 1: SERVICE FILES TO DELETE (9 files)

All located in `backend/src/services/`:

### DELETE THESE 9 FILES:

1. **`productionEventIngestor.ts`** (~380 lines)
   - RPC polling for blockchain events
   - No longer needed (database-first model)
2. **`productionEventQueue.ts`** (~200 lines)
   - BullMQ Redis queue for events
   - No longer needed

3. **`productionEventWorker.ts`** (~250 lines)
   - Event handler and processor
   - No longer needed

4. **`productionWebSocketBroadcaster.ts`** (~220 lines)
   - WebSocket server with Redis adapter
   - No longer needed

5. **`webSocketBroadcaster.ts`** (~150 lines)
   - Legacy WebSocket implementation
   - No longer needed

6. **`eventIngestor.ts`** (~200 lines)
   - Legacy event ingestor
   - No longer needed

7. **`eventQueue.ts`** (~180 lines)
   - Legacy queue service
   - No longer needed

8. **`eventWorker.ts`** (~200 lines)
   - Legacy event worker
   - No longer needed

9. **`realtimeEventPublisher.ts`** (~100 lines)
   - Publishes real-time events to clients
   - No longer needed

---

## 📥 SECTION 2: IMPORTS TO REMOVE (From backend/src/index.ts)

**File**: `backend/src/index.ts`

**Lines 132-137 - DELETE**:

```typescript
const { productionEventIngestor } =
  await import("./services/productionEventIngestor");
const { productionEventQueue } =
  await import("./services/productionEventQueue");
const { productionEventWorker } =
  await import("./services/productionEventWorker");
const { productionWebSocketBroadcaster } =
  await import("./services/productionWebSocketBroadcaster");
const { rpcFailoverManager } = await import("./services/rpcFailoverManager");
```

**Also DELETE from startup logic**:

- WebSocket server initialization
- Event queue startup
- Event worker startup
- Event ingestor startup
- RPC failover manager setup

---

## 📝 SECTION 3: CONFIGURATION FILES TO UPDATE

### 1. backend/.env

**DELETE these lines**:

```env
ENABLE_EVENT_STREAM=true          (line 26)
WEBSOCKET_ENABLED=true            (line 27)
REDIS_URL=                        (line 39)
```

### 2. backend/.env.local

**DELETE these lines**:

```env
ENABLE_EVENT_STREAM=true          (if present)
WEBSOCKET_ENABLED=true            (if present)
REDIS_URL=redis://...             (if present)
```

### 3. .env.production

**DELETE these sections**:

```env
# Redis Configuration (optional for Railway) (lines 70-72)
# If using Railway Redis plugin: ${{Redis.REDIS_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
```

### 4. backend/src/config/env.ts

**DELETE from AppEnv type**:

```typescript
ENABLE_EVENT_STREAM: boolean;
EVENT_CHUNK_SIZE: number;
EVENT_POLL_INTERVAL_MS: number;
INDEXER_RETRY_LIMIT: number;
INDEXER_BACKOFF_MS: number;
WEBSOCKET_ENABLED: boolean;
RPC_TIMEOUT_MS: number;
EVENT_WORKER_CONCURRENCY: number;
```

**DELETE from validation logic**:

- ENABLE_EVENT_STREAM validation
- WEBSOCKET_ENABLED validation
- EVENT\_\* environment variable parsing
- REDIS_URL validation for event streaming

### 5. backend/src/config/production.ts

**DELETE**:

- References to productionEventIngestor health check
- References to productionEventQueue health check
- References to productionEventWorker health check
- WebSocket broadcaster health check

---

## 🔧 SECTION 4: IMPORTS & USAGE TO REMOVE

### From controllers/questController.ts

**DELETE**:

```typescript
import { realtimeEventPublisher } from "../services/realtimeEventPublisher";

// In acceptQuestOnchain() function:
// Line ~340-350: Delete event publishing block
// TODO: Publish realtime event for sync (all lines)
//   await realtimeEventPublisher.publishQuestAccepted({...});
```

### From middleware/rateLimits.ts

**Line 13 - DELETE**:

```typescript
import { createClient } from "redis";
```

**DELETE**: Any redis store initialization for rate limiting

---

## 📦 SECTION 5: DEPENDENCIES TO REMOVE (From backend/package.json)

**DELETE from dependencies**:

```json
"@socket.io/redis-adapter": "^8.3.0",    // Redis adapter for Socket.io
"bullmq": "^5.76.8",                     // Queue system (depends on Redis)
"ioredis": "^5.10.1",                    // Redis client
"rate-limit-redis": "^3.0.1",            // Redis rate limiter store
"redis": "^4.6.10",                      // Redis client
"socket.io": "^4.8.3",                   // WebSocket server
```

**DELETE from devDependencies**:

```json
"@types/redis": "^4.0.11"                // TypeScript types for Redis
```

---

## 🌍 SECTION 6: ENVIRONMENT VARIABLES TO REMOVE

From `.env` files, delete:

```env
ENABLE_EVENT_STREAM              # Toggle for event streaming
EVENT_CHUNK_SIZE                 # Event batch size
EVENT_POLL_INTERVAL_MS           # How often to poll RPC
INDEXER_FROM_BLOCK               # Starting block for event indexing
INDEXER_POLL_INTERVAL_MS         # Poll interval for indexing
INDEXER_RETRY_LIMIT              # Retry attempts for indexing
INDEXER_BACKOFF_MS               # Backoff between retries
REDIS_URL                        # Redis connection string
REDIS_HOST                       # Redis hostname (if used)
REDIS_PORT                       # Redis port (if used)
REDIS_PASSWORD                   # Redis password (if used)
WEBSOCKET_ENABLED                # Toggle for WebSocket
WS_HOST                          # WebSocket host (if used)
WS_PORT                          # WebSocket port (if used)
EVENT_WORKER_CONCURRENCY         # Concurrency level for event processing
RPC_TIMEOUT_MS                   # RPC call timeout
```

---

## 📋 SECTION 7: FILES THAT REFERENCE DELETED SERVICES

**No updates needed** (these services are not used in database-first model):

- controllers/questController.ts (event publish calls are already in comments/optional blocks)
- services/chain.ts
- services/contracts.ts
- services/verification.ts
- controllers/realtimeController.ts (if it exists)

---

## ✅ SECTION 8: SAFE DELETION ORDER

### Step 1: Backup (SAFE)

```bash
git stash  # Save any current changes
git checkout -b cleanup/remove-redis-websocket  # Create new branch
```

### Step 2: Update Configuration (SAFE)

```bash
# Remove environment variables from:
# - backend/.env
# - backend/.env.local
# - .env.production
```

### Step 3: Update Code (SAFE)

```bash
# Update backend/src/index.ts - remove imports and service initialization
# Update backend/src/config/env.ts - remove env vars from types and validation
# Update backend/src/config/production.ts - remove health checks
# Remove event publishing from questController.ts (if present)
```

### Step 4: Update package.json (SAFE)

```bash
# Remove dependencies from backend/package.json
npm install  # Update node_modules and package-lock.json
```

### Step 5: Delete Service Files (SAFE)

```bash
# Delete all 9 service files:
rm backend/src/services/productionEventIngestor.ts
rm backend/src/services/productionEventQueue.ts
rm backend/src/services/productionEventWorker.ts
rm backend/src/services/productionWebSocketBroadcaster.ts
rm backend/src/services/webSocketBroadcaster.ts
rm backend/src/services/eventIngestor.ts
rm backend/src/services/eventQueue.ts
rm backend/src/services/eventWorker.ts
rm backend/src/services/realtimeEventPublisher.ts
```

### Step 6: Verify (SAFE)

```bash
npm run build  # Verify no TypeScript errors
npm run lint   # Verify code quality
```

### Step 7: Commit (SAFE)

```bash
git add .
git commit -m "cleanup: remove redis and websocket code (database-first model)"
git push origin cleanup/remove-redis-websocket
```

---

## 🔍 SECTION 9: WHAT'S NOT AFFECTED

✅ **Database**: No schema changes  
✅ **Smart Contracts**: No changes  
✅ **API Routes**: No changes  
✅ **Authentication**: No changes  
✅ **Proof Verification**: No changes  
✅ **Frontend**: No changes  
✅ **Backward Compatibility**: 100% maintained

---

## 🧪 SECTION 10: VERIFICATION CHECKLIST

After deletion, verify:

- [ ] No TypeScript compilation errors: `npm run build`
- [ ] No linting errors: `npm run lint`
- [ ] Backend starts without errors: `npm run dev`
- [ ] Database connection still works
- [ ] Can generate quests
- [ ] Can accept quests
- [ ] Can submit proofs
- [ ] Can claim rewards
- [ ] No import errors in logs

---

## 🚨 ROLLBACK PLAN

If anything breaks:

```bash
# Revert to previous commit
git reset --hard HEAD~1

# Or restore from git
git restore backend/src/
backend/package.json
backend/.env
.env.production

# Reinstall dependencies
npm install
```

No database action needed (no schema changes made).

---

## ⚠️ IMPORTANT NOTES

1. **No Breaking Changes**: Database-first model doesn't use these services
2. **Easy Rollback**: Everything is in git, can revert instantly
3. **Clean Deletion**: Removing ~2,500 lines of unused code
4. **Size Reduction**: ~150MB removed from node_modules
5. **Simplification**: 8 environment variables eliminated

---

## 📊 SUMMARY TABLE

| Item               | Files | Lines  | Size    |
| ------------------ | ----- | ------ | ------- |
| **Service Files**  | 9     | ~2,500 | ~500KB  |
| **Config Changes** | 5     | ~20    | Minimal |
| **Dependencies**   | 8     | -      | ~150MB  |
| **Env Variables**  | 8     | -      | Removed |

---

## ✅ READY FOR DELETION?

**BEFORE PROCEEDING**: Please confirm:

- [ ] This audit is correct
- [ ] You want to delete all 9 service files
- [ ] You want to remove all 8 dependencies
- [ ] You want to delete all 8 environment variables
- [ ] You understand this is destructive (but reversible via git)

---

**Status**: WAITING FOR CONFIRMATION  
**Risk Level**: LOW (fully reversible, no data loss)  
**Estimated Time**: 10-15 minutes
