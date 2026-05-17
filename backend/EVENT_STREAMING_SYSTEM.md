# QuestForge AI - Real-Time Blockchain Event Streaming System

Production-grade real-time event indexing and broadcasting architecture for Celo blockchain integration.

## 🏗️ Architecture Overview

```
Celo Smart Contracts
  ↓
Event Ingestor (Chunked log scanner, RPC resilient)
  ↓
Redis Queue (BullMQ - distributed task queue)
  ↓
Event Workers (Parallel processors, 5 concurrent)
  ↓
PostgreSQL (Prisma ORM - event storage & state)
  ↓
WebSocket Broadcaster (Socket.IO - real-time)
  ↓
Frontend (React - live UI updates)
```

## 🚀 Key Components

### 1. **Robust RPC Provider** (`rpcProvider.ts`)

- **Purpose**: Resilient blockchain RPC interaction
- **Features**:
  - Automatic retry with exponential backoff
  - Request timeout handling
  - Chunked log fetching (avoids RPC limits)
  - Health status tracking
  - Graceful degradation on RPC failures
- **Config**:
  - `CELO_RPC_URL`: Primary RPC endpoint
  - `RPC_TIMEOUT_MS`: Call timeout (default: 30s)
  - `INDEXER_RETRY_LIMIT`: Max retries (default: 10)
  - `INDEXER_BACKOFF_MS`: Initial backoff (default: 2s)

### 2. **Event Ingestor** (`eventIngestor.ts`)

- **Purpose**: Continuously scan blockchain for events
- **Features**:
  - Chunked block range scanning (configurable size)
  - Persistent block state in DB
  - Incremental processing with resume capability
  - Error tracking and recovery
  - Polling-based with configurable interval
- **Config**:
  - `ENABLE_EVENT_STREAM`: Master switch (default: false)
  - `EVENT_CHUNK_SIZE`: Blocks per chunk (default: 5000)
  - `EVENT_POLL_INTERVAL_MS`: Poll frequency (default: 5s)
  - `INDEXER_FROM_BLOCK`: Start block (default: 0)

### 3. **Redis Queue (BullMQ)** (`eventQueue.ts`)

- **Purpose**: Distributed event processing queue
- **Features**:
  - Job persistence and retry
  - Exponential backoff on failures
  - Concurrency control
  - Failed job tracking
  - Job completion tracking
- **Config**:
  - `REDIS_URL`: Redis connection string (required when `ENABLE_EVENT_STREAM=true`)
  - `EVENT_WORKER_CONCURRENCY`: Parallel workers (default: 5)

### 4. **Event Decoder** (`eventDecoder.ts`)

- **Purpose**: Parse and decode blockchain events
- **Supported Events**:
  - `QuestCreated` - New quest available
  - `QuestStarted` - Player stakes and starts quest
  - `QuestSubmitted` - Player submits proof
  - `QuestVerified` - Quest result verified
  - `RewardMinted` - NFT reward created
  - `RewardReserved` - Funds reserved for quest
  - `StakeLocked` - Player stake locked
  - `RewardReleased` - Reward released
  - `RewardPaid` - Final payout sent
  - `RewardRefunded` - Refund issued

### 5. **Event Worker** (`eventWorker.ts`)

- **Purpose**: Process queued events and update database
- **Features**:
  - Parallel processing (configurable concurrency)
  - Per-event-type handlers
  - Database updates
  - WebSocket broadcasting
  - Error isolation (won't crash backend)
- **Config**:
  - `EVENT_WORKER_CONCURRENCY`: Parallel jobs (default: 5)

### 6. **WebSocket Broadcaster** (`webSocketBroadcaster.ts`)

- **Purpose**: Real-time event push to frontend
- **Features**:
  - Socket.IO server on HTTP server
  - User-specific event rooms
  - Creator-specific event rooms
  - Broadcast to all/specific clients
  - Automatic reconnection handling
  - CORS security
- **Config**:
  - `WEBSOCKET_ENABLED`: Enable Socket.IO (default: true)
  - `CORS_ORIGINS`: Allowed frontend origins

## 🔄 Event Flow

1. **Ingestor** polls blockchain in 5000-block chunks
2. **Ingestor** decodes events and stores to `ChainEvent` table
3. **Ingestor** enqueues events to BullMQ
4. **Worker** processes queued events (5 concurrent)
5. **Worker** updates database and records processed status
6. **Broadcaster** emits WebSocket events to connected clients
7. **Frontend** receives real-time updates and updates UI

## 📊 Database Models

### `IndexerState`

Tracks blockchain indexing progress

```prisma
model IndexerState {
  id                  String
  key                 String    @unique
  value               String
  lastBlockProcessed  BigInt
  lastBlockTimestamp  DateTime?
  isHealthy           Boolean
  errorCount          Int
}
```

### `ChainEvent`

Stores all decoded blockchain events

```prisma
model ChainEvent {
  id                  String
  eventKey            String    @unique  // "{txHash}:{logIndex}"
  eventName           String    // "QuestCreated", etc.
  eventType           String    // "quest_created", etc.
  blockNumber         BigInt
  transactionHash     String
  logIndex            Int
  data                Json      // Raw event data
  decodedData         Json?     // Parsed event data
  chainQuestId        BigInt?
  playerWallet        String?
  creatorWallet       String?
  processed           Boolean
  processedAt         DateTime?
}
```

### `EventQueue`

Tracks BullMQ job processing

```prisma
model EventQueue {
  id              String
  jobId           String    @unique
  chainEventId    String
  status          String    // pending, processing, completed, failed
  retries         Int
  attempts        Int
  processedAt     DateTime?
}
```

## 🔌 Frontend Integration

### Install socket.io-client

```bash
npm install socket.io-client
```

### Basic Usage (React)

```typescript
import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

function QuestFeed() {
  const [events, setEvents] = useState([]);

  useEffect(() => {
    const socket = io(window.location.origin);

    socket.on('quest:created', (event) => {
      console.log('New quest:', event);
      setEvents(prev => [event, ...prev]);
    });

    socket.on('proof:submitted', (event) => {
      console.log('Proof submitted:', event);
    });

    socket.on('reward:claimed', (event) => {
      console.log('Reward claimed:', event);
    });

    return () => socket.disconnect();
  }, []);

  return (
    <div>
      {events.map(e => (
        <div key={e.transactionHash}>
          {e.eventName}
        </div>
      ))}
    </div>
  );
}
```

### Subscribe to User Events

```typescript
// Subscribe to specific user's events
socket.emit("subscribe:user", userWallet.toLowerCase());

// Receive user-specific events
socket.on("quest:created", (event) => {
  if (event.playerWallet === userWallet) {
    // Handle player's quest
  }
});
```

### Use Pre-built Hook

```typescript
import { useQuestForgeEvents } from '@services/socketIOClient';

function MyComponent() {
  const { isConnected, events, client } = useQuestForgeEvents(userWallet);

  return (
    <div>
      Status: {isConnected ? '✓' : '✗'}
      Events: {events.length}
    </div>
  );
}
```

## 🔐 Resilience & Error Handling

### RPC Failures

- Automatic retry with exponential backoff
- Max 10 retries (configurable)
- Timeout handling (30s default)
- Provider marked unhealthy after 5 consecutive errors
- Partial failures tracked but don't crash system

### Queue Failures

- Failed events kept in DB for debugging
- Automatic retry with BullMQ backoff
- Worker isolation prevents crash
- Failed event count tracked

### Backend Isolation

- Event processing errors don't crash backend
- Each worker failure is logged and tracked
- WebSocket issues don't affect other systems
- Graceful shutdown with cleanup

## 🚨 Health Check Endpoints

### System Health

```bash
GET /health
```

Response:

```json
{
  "healthy": true,
  "environment": "development",
  "chainId": 42220,
  "checks": {
    "database": true,
    "blockchain": true,
    "verifier": true,
    "memory": true
  }
}
```

### Event Stream Health

```bash
GET /health/events
```

Response:

```json
{
  "ingestor": {
    "running": true,
    "syncing": false,
    "lastBlockProcessed": 1234567,
    "consecutiveErrors": 0,
    "enabled": true,
    "pollIntervalMs": 5000,
    "chunkSize": 5000
  },
  "worker": {
    "running": true,
    "concurrency": 5
  },
  "queue": {
    "waiting": 42,
    "active": 3,
    "delayed": 0,
    "failed": 1,
    "completed": 1000
  },
  "websocket": {
    "connectedClients": 15,
    "enabled": true
  },
  "healthy": true
}
```

## 🚀 Deployment Configuration

### Production Checklist

- [ ] All contract addresses set in `.env`
- [ ] PostgreSQL configured and running
- [ ] Redis configured and running if `ENABLE_EVENT_STREAM=true`
- [ ] CELO_RPC_URL set to stable provider
- [ ] Frontend origin in CORS_ORIGINS
- [ ] WEBSOCKET_ENABLED=true
- [ ] ENABLE_EVENT_STREAM=true only after Redis is configured
- [ ] RPC_TIMEOUT_MS appropriate for provider
- [ ] EVENT_WORKER_CONCURRENCY scaled for load
- [ ] Monitoring configured for health endpoints

### Scaling Considerations

- Multiple backend instances need shared Redis
- Each instance runs independent ingestor (safe - DB deduplication)
- Each instance runs workers from shared queue
- WebSocket requires sticky sessions or Redis adapter
- Event deduplication via `eventKey` prevents duplicates

## 📈 Monitoring & Metrics

Monitor these key metrics:

1. **Event Processing Latency**
   - Time from block to processed event
   - Target: < 5 seconds for typical load

2. **Queue Depth**
   - Size of pending event jobs
   - Alert if > 1000

3. **Worker Failures**
   - Track in EventQueue table
   - Alert if failure rate > 5%

4. **RPC Health**
   - Call success rate
   - Consecutive errors count
   - Provider health status

5. **WebSocket Connections**
   - Active client count
   - Connection churn rate
   - Broadcast latency

## 🔧 Troubleshooting

### Events not being processed

1. Check `ENABLE_EVENT_STREAM=true`
2. Check Redis connection: `redis-cli ping`
3. Check contract addresses are set
4. Check PostgreSQL connection
5. Review ingestor logs: `GET /health/events`

### WebSocket not connecting

1. Check `WEBSOCKET_ENABLED=true`
2. Check frontend origin in `CORS_ORIGINS`
3. Check frontend socket connection URL
4. Check browser console for Socket.IO errors
5. Verify port is accessible

### High latency

1. Increase `EVENT_WORKER_CONCURRENCY`
2. Decrease `EVENT_POLL_INTERVAL_MS`
3. Decrease `EVENT_CHUNK_SIZE` for faster polling
4. Check database query performance
5. Check Redis latency

### Database errors

1. Check `EVENT_CHUNK_SIZE` not causing memory issues
2. Check database connection limits
3. Run migrations: `npm run prisma:migrate`
4. Check disk space

## 📚 API Reference

### Event Emission Events

```typescript
// Quest Events
"quest:created"; // New quest available
"quest:started"; // Player started quest
"proof:submitted"; // Proof submitted for verification
"reward:claimed"; // Quest completed, reward claimed

// NFT Events
"nft:minted"; // Reward NFT minted

// Treasury Events
"reward:reserved"; // Reward reserved from treasury
"stake:locked"; // Player stake locked
"reward:released"; // Reward released
"reward:paid"; // Final reward payout
"reward:refunded"; // Refund issued
```

### Event Structure

```typescript
{
  eventType: string           // e.g., 'quest_created'
  eventName: string           // e.g., 'QuestCreated'
  blockNumber: string         // BigInt as string
  transactionHash: string     // 0x...
  timestamp: string           // ISO 8601
  data: Record<string, any>   // Event-specific data
  chainQuestId?: string       // Associated quest ID
  playerWallet?: string       // Involved player
  creatorWallet?: string      // Quest creator
}
```

## 🎯 Next Steps

1. **Deploy Smart Contracts** to get real contract addresses
2. **Run Prisma Migration**: `npm run prisma:migrate`
3. **Install Dependencies**: `npm install` (backend & frontend)
4. **Start Backend**: `npm run dev`
5. **Start Frontend**: `npm run dev`
6. **Test Integration**: Check `/health/events` endpoint
7. **Monitor Real-Time**: Open browser dev tools and watch Socket.IO events

---

**Version**: 1.0.0 | **Date**: May 2026 | **Status**: Production-Ready
