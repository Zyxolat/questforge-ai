# ForgeQuest Online Production Upgrade - Implementation Plan

**Status**: Starting Full Implementation  
**Date**: May 13, 2026  
**Target**: Production-Grade AI-Native Onchain Game Engine on Celo

---

## PHASE 1: ARCHITECTURE CLEANUP & UNIFICATION

### 1.1 Unified Event Architecture

**Current State**:

- Legacy event system: `eventIngestor.ts`, `eventQueue.ts`, `eventWorker.ts`, `webSocketBroadcaster.ts`
- Production system (ACTIVE): `productionEventIngestor.ts`, `productionEventQueue.ts`, `productionEventWorker.ts`, `productionWebSocketBroadcaster.ts`
- Two parallel verification systems: `indexer.ts` + `verification.ts`

**Target Architecture**:

```
Blockchain Events
→ productionEventIngestor (RPC failover-aware polling)
→ productionEventQueue (with backpressure control)
→ productionEventWorker (event-type handler)
→ State Projectors (update Postgres)
→ productionWebSocketBroadcaster (Redis-backed)
→ Frontend (realtime subscriptions)
```

**Implementation**:

- [ ] Keep production event system as authoritative
- [ ] Remove legacy files: `eventIngestor.ts`, `eventQueue.ts`, `eventWorker.ts`, `webSocketBroadcaster.ts`
- [ ] Consolidate `indexer.ts` functionality into `productionEventWorker.ts`
- [ ] Consolidate `verification.ts` into `productionEventWorker.ts`
- [ ] Remove duplicate verification logic
- [ ] Ensure single source of truth for all state

---

## PHASE 2: DATABASE SCHEMA ENHANCEMENTS

### 2.1 New Models for AI Systems

**Add to Prisma Schema**:

```prisma
// AI NPC System
model NPC {
  id              String   @id @default(cuid())
  type            String   // "merchant", "villain", "guildmaster", "faction_leader"
  name            String
  personality     Json     // personality traits
  currentLocation String   // world location
  reputation      Float    @default(0.0)

  conversations   NPCConversation[]
  questsGiven     Quest[]  @relation("npcQuests")
  memories        NPCMemory[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model NPCMemory {
  id              String   @id @default(cuid())
  npc             NPC      @relation(fields: [npcId], references: [id], onDelete: Cascade)
  npcId           String
  wallet          String   // player wallet
  memory          String   // structured memory about this player
  embedding       Float[]  // vector embedding for semantic search
  importanceScore Float    @default(1.0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

// Agent Identity System (ERC-8004)
model AgentIdentity {
  id                String   @id @default(cuid())
  wallet            String   @unique
  agentName         String
  agentDescriptor   String   // brief AI agent description
  personalityVector Float[]  // learned player behavioral profile
  memoryGraph       Json     // long-term narrative state
  reputationScore   Float    @default(0.0)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}

model AgentMemory {
  id            String   @id @default(cuid())
  agent         AgentIdentity @relation(fields: [agentId], references: [id], onDelete: Cascade)
  agentId       String
  questId       String   // reference to quest history
  memoryType    String   // "quest_completion", "npc_interaction", "faction_choice"
  memoryData    Json
  embedding     Float[]  // vector embedding
  timestamp     DateTime @default(now())
}

// Clan/Guild System
model Clan {
  id              String   @id @default(cuid())
  name            String   @unique
  description     String?
  founder         User     @relation("ClanFounder", fields: [founderId], references: [id])
  founderId       String
  members         User[]   @relation("ClanMembers")
  questsCompleted Int      @default(0)
  totalRewards    Float    @default(0)
  treasuryBalance Float    @default(0)
  reputation      Float    @default(0)
  level           Int      @default(1)

  clanQuests      ClanQuest[]
  treasury        ClanTreasury?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model ClanQuest {
  id              String   @id @default(cuid())
  clan            Clan     @relation(fields: [clanId], references: [id], onDelete: Cascade)
  clanId          String
  quest           Quest    @relation(fields: [questId], references: [id], onDelete: Cascade)
  questId         String
  participants    User[]
  status          String   // "active", "completed", "failed"
  rewardDistribution Json
  createdAt       DateTime @default(now())
}

model ClanTreasury {
  id              String   @id @default(cuid())
  clan            Clan     @relation(fields: [clanId], references: [id], onDelete: Cascade)
  clanId          String   @unique
  balance         Float    @default(0)
  transactions    ClanTreasuryTx[]
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

model ClanTreasuryTx {
  id              String   @id @default(cuid())
  treasury        ClanTreasury @relation(fields: [treasuryId], references: [id], onDelete: Cascade)
  treasuryId      String
  type            String   // "deposit", "withdrawal", "quest_reward", "raid_loot"
  amount          Float
  initiatedBy     User?    @relation(fields: [userId], references: [id])
  userId          String?
  txHash          String?
  createdAt       DateTime @default(now())
}

// World State & Events
model WorldEvent {
  id              String   @id @default(cuid())
  name            String
  description     String
  type            String   // "boss_event", "faction_war", "seasonal_modifier"
  startTime       DateTime
  endTime         DateTime
  reward          Float
  multiplier      Float    @default(1.0)
  active          Boolean  @default(true)
  createdAt       DateTime @default(now())
}

model DailyQuest {
  id              String   @id @default(cuid())
  date            String   // YYYY-MM-DD
  questTemplate   String   // JSON template
  difficulty      Int
  createdAt       DateTime @default(now())
}

// Update existing User model
// Add fields:
// - clanId (optional foreign key)
// - agentId (optional foreign key)
// - joinedClanAt DateTime?
```

---

## PHASE 3: AI SYSTEMS IMPLEMENTATION

### 3.1 AI Difficulty Engine

**Location**: `backend/src/services/aiDifficultyEngine.ts`

**Responsibilities**:

- Analyze player:
  - Level, XP, streak, wallet history
  - Recent completion rate
  - Risk appetite
  - OnChain behavior
- Generate adaptive difficulty (1-5)
- Adjust stake/reward bounds
- Return difficulty with reasoning

**Implementation** (pseudocode):

```typescript
async function calculateDifficulty(userId: string): Promise<{
  difficulty: number;
  reasoning: string;
  stakeBounds: { min: number; max: number };
  rewardBounds: { min: number; max: number };
  recommendedStake: number;
}> {
  const user = await getUser(userId);
  const history = await getRecentQuestHistory(userId);
  const completionRate = history.completed / history.total;
  const streakBonus = user.streak > 3 ? 1 : 0.8;

  // Base difficulty from level
  let difficulty = Math.ceil(user.level / 5);

  // Adjust based on performance
  if (completionRate > 0.8) difficulty = Math.min(5, difficulty + 1);
  if (completionRate < 0.5) difficulty = Math.max(1, difficulty - 1);

  // Apply streak bonus
  difficulty = Math.round(difficulty * streakBonus);

  // Bounds scale with difficulty
  const stakeBounds = {
    min: 0.01 + (difficulty - 1) * 0.005,
    max: Math.min(10, 0.1 * difficulty),
  };

  return { difficulty, stakeBounds, rewardBounds, recommendedStake };
}
```

### 3.2 AI Reward Engine

**Location**: `backend/src/services/aiRewardEngine.ts`

**Responsibilities**:

- Calculate dynamic CELO rewards
- Determine NFT rarity
- Calculate XP gain
- Apply clan bonuses
- Apply risk multipliers
- Ensure treasury safety

**Implementation** (pseudocode):

```typescript
async function calculateReward(
  questId: string,
  playerId: string,
): Promise<{
  celoAmount: number;
  nftRarity: string;
  xpAmount: number;
  multipliers: {
    streak: number;
    clan: number;
    risk: number;
  };
}> {
  const quest = await getQuest(questId);
  const player = await getUser(playerId);
  const treasury = await getTreasuryBalance();

  // Base reward from difficulty
  let celoReward = 0.01 + (quest.difficulty - 1) * 0.08;

  // Apply multipliers
  const streakMultiplier = 1 + Math.min(player.streak, 10) * 0.05;
  const clanBonus = player.clanId ? 1.1 : 1.0;
  const riskMultiplier = calculateRiskMultiplier(quest);

  celoReward *= streakMultiplier * clanBonus * riskMultiplier;

  // Cap and safety check
  celoReward = Math.min(celoReward, 0.5); // Hard cap
  celoReward = Math.min(celoReward, treasury * 0.01); // Treasury safety

  // Determine NFT rarity
  const rarity =
    celoReward > 0.3
      ? "legendary"
      : celoReward > 0.2
        ? "epic"
        : celoReward > 0.1
          ? "rare"
          : "common";

  return {
    celoAmount: celoReward,
    nftRarity: rarity,
    xpAmount: 150,
    multipliers,
  };
}
```

### 3.3 AI NPC System

**Location**: `backend/src/services/aiNPCSystem.ts`

**Responsibilities**:

- Generate persistent NPCs with personality
- Store NPC-player interaction history
- Generate context-aware dialogue
- Track NPC-player relationships
- Generate NPC-specific quests

**Implementation** (pseudocode):

```typescript
async function generateNPCDialogue(
  npcId: string,
  playerId: string,
): Promise<string> {
  const npc = await getNPC(npcId);
  const playerMemory = await getNPCMemoryForPlayer(npcId, playerId);
  const recentInteractions = await getRecentInteractions(npcId, playerId);

  const prompt = buildNPCPrompt(npc, playerMemory, recentInteractions);
  const dialogue = await Groq.createChatCompletion({
    messages: [
      { role: "system", content: buildNPCSystemPrompt(npc.personality) },
      { role: "user", content: prompt },
    ],
    max_tokens: 150,
  });

  // Store interaction for future memory
  await storeNPCInteraction(npcId, playerId, dialogue);

  return dialogue;
}

async function generateNPCQuest(npcId: string): Promise<QuestTemplate> {
  // Generate quest tied to this NPC's personality and world state
  // Quest title, objective, rewards should reflect NPC character
  return {};
}
```

### 3.4 Agent Identity System (ERC-8004 Compatible)

**Location**: `backend/src/services/agentIdentitySystem.ts`

**Responsibilities**:

- Create persistent agent identity per wallet
- Maintain memory graph and narrative state
- Track behavioral embeddings
- Enable agent-to-agent interactions
- Store quest history context

**Implementation** (pseudocode):

```typescript
async function initializeAgentIdentity(wallet: string): Promise<AgentIdentity> {
  // Create new agent identity for wallet
  const agentName = generateAgentName();
  const personalityVector = generateRandomEmbedding();

  const agent = await prisma.agentIdentity.create({
    data: {
      wallet,
      agentName,
      personalityVector,
      memoryGraph: {
        narrativeArc: [],
        questChain: [],
        relationshipMap: {},
      },
    },
  });

  return agent;
}

async function recordQuestMemory(
  agentId: string,
  questId: string,
  outcome: "success" | "failure",
): Promise<void> {
  // Store memory of this quest in agent's long-term store
  const questData = await getQuest(questId);
  const embedding = await generateEmbedding(questData.description);

  await prisma.agentMemory.create({
    data: {
      agentId,
      questId,
      memoryType: "quest_completion",
      memoryData: { outcome, difficulty: questData.difficulty },
      embedding,
    },
  });

  // Update agent's narrative state
  await updateAgentNarrativeState(agentId);
}
```

---

## PHASE 4: MULTI-TRANSACTION QUEST SYSTEM

### 4.1 Quest Transaction Validator

**Location**: `backend/src/services/multiTxQuestValidator.ts`

**Responsibilities**:

- Enforce minimum 7 transactions per quest
- Validate transaction diversity (transfers, approvals, swaps, etc.)
- Calculate onchain engagement score
- Track transaction chain completeness

**Implementation** (pseudocode):

```typescript
interface QuestTransactionRequirement {
  type: "transfer" | "approval" | "contract_call" | "swap";
  minCount: number;
  description: string;
}

const MULTI_TX_QUEST_TEMPLATE: QuestTransactionRequirement[] = [
  { type: "transfer", minCount: 2, description: "2+ CELO transfers" },
  { type: "approval", minCount: 2, description: "2+ token approvals" },
  {
    type: "contract_call",
    minCount: 2,
    description: "2+ contract interactions",
  },
  { type: "swap", minCount: 1, description: "1+ token swap" },
];

async function validateQuestTransactions(questId: string): Promise<{
  valid: boolean;
  txCount: number;
  requirements: QuestTransactionRequirement[];
  engagementScore: number;
}> {
  const submissions = await getQuestProofSubmissions(questId);
  const txCounts = countTransactionsByType(submissions);

  const valid = MULTI_TX_QUEST_TEMPLATE.every(
    (req) => (txCounts[req.type] || 0) >= req.minCount,
  );

  const engagementScore = calculateEngagementScore(txCounts);

  return {
    valid,
    txCount: submissions.length,
    requirements: MULTI_TX_QUEST_TEMPLATE,
    engagementScore,
  };
}
```

---

## PHASE 5: CLAN/GUILD SYSTEM

### 5.1 Clan Management

**Location**: `backend/src/services/clanSystem.ts`

**Responsibilities**:

- Create and manage clans
- Handle member joins/leaves
- Manage clan treasury
- Distribute quest rewards
- Track clan statistics

**Implementation** (pseudocode):

```typescript
async function createClan(creatorId: string, clanName: string): Promise<Clan> {
  const clan = await prisma.clan.create({
    data: {
      name: clanName,
      founderId: creatorId,
      members: { connect: [{ id: creatorId }] },
    },
  });

  await prisma.clanTreasury.create({
    data: { clanId: clan.id },
  });

  return clan;
}

async function distributeClanReward(
  questId: string,
  amount: number,
): Promise<void> {
  // Distribute reward across all clan members who participated
  const quest = await getQuest(questId);
  const clan = await getClanForMember(quest.playerId);

  const distribution = calculateEvenDistribution(amount, clan.members.length);

  for (const member of clan.members) {
    await creditReward(member.id, distribution);
  }
}
```

---

## PHASE 6: FRONTEND REALTIME ARCHITECTURE

### 6.1 WebSocket Integration

**Target**: Replace polling with true realtime Socket.IO subscriptions

**Key Updates**:

- Quest creation → realtime broadcast
- Staking → realtime update
- Proof submission → realtime notification
- Verification → realtime reward update
- NFT mints → realtime inventory update
- Leaderboard changes → realtime broadcast
- NPC events → realtime dialogue
- Clan updates → realtime broadcast

**Implementation Location**: `frontend/src/lib/socket.ts`

```typescript
export class ForgeQuestSocket {
  private socket: Socket;

  constructor() {
    this.socket = io(import.meta.env.VITE_API_URL, {
      auth: {
        token: getStoredJWT(),
      },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
  }

  subscribeToQuestUpdates(
    questId: string,
    callback: (data: QuestUpdate) => void,
  ) {
    this.socket.on(`quest:${questId}:updated`, callback);
  }

  subscribeToRewards(wallet: string, callback: (data: RewardEvent) => void) {
    this.socket.on(`reward:${wallet}`, callback);
  }

  subscribeToNPCDialogue(npcId: string, callback: (data: NPCMessage) => void) {
    this.socket.on(`npc:${npcId}:message`, callback);
  }
}
```

---

## PHASE 7: PRODUCTION HARDENING

### 7.1 Monitoring & Observability

**Location**: `backend/src/services/monitoring.ts`

**Implement**:

- Event stream health metrics
- Queue depth monitoring
- Transaction success rate tracking
- Error rate alerting
- RPC failover health dashboard
- WebSocket connection metrics

### 7.2 Resilience Patterns

**Implement**:

- Event replay capability
- Dead-letter queue for failed events
- Graceful degradation
- Rate limiting
- Circuit breaker for RPC calls
- Queue backpressure handling

---

## PHASE 8: IMPLEMENTATION CHECKLIST

### Phase 1: Architecture Cleanup

- [ ] Remove legacy `eventIngestor.ts`
- [ ] Remove legacy `eventQueue.ts`
- [ ] Remove legacy `eventWorker.ts`
- [ ] Remove legacy `webSocketBroadcaster.ts`
- [ ] Consolidate `indexer.ts` into production worker
- [ ] Consolidate `verification.ts` into production worker
- [ ] Update `index.ts` to remove legacy startup

### Phase 2: Schema Updates

- [ ] Add NPC and NPCMemory models
- [ ] Add AgentIdentity and AgentMemory models
- [ ] Add Clan, ClanQuest, ClanTreasury models
- [ ] Add WorldEvent, DailyQuest models
- [ ] Add fields to User model (clanId, agentId)
- [ ] Generate new migration
- [ ] Run migration in production

### Phase 3: AI Systems

- [ ] Implement aiDifficultyEngine.ts
- [ ] Implement aiRewardEngine.ts
- [ ] Implement aiNPCSystem.ts
- [ ] Implement agentIdentitySystem.ts
- [ ] Create AI system controller routes
- [ ] Add comprehensive validation

### Phase 4: Multi-TX Quests

- [ ] Create multiTxQuestValidator.ts
- [ ] Update quest generation to require multi-TX
- [ ] Add TX requirement display in frontend
- [ ] Create TX tracking dashboard

### Phase 5: Clan System

- [ ] Implement clanSystem.ts
- [ ] Create clan API routes
- [ ] Implement clan treasury mechanics
- [ ] Implement reward distribution logic

### Phase 6: Frontend Realtime

- [ ] Create `frontend/src/lib/socket.ts`
- [ ] Refactor components to use Socket.IO
- [ ] Add realtime quest updates
- [ ] Add realtime reward notifications
- [ ] Add NPC dialogue interface
- [ ] Add clan interface

### Phase 7: Production Hardening

- [ ] Add structured logging
- [ ] Add metrics collection
- [ ] Add health endpoints
- [ ] Add rate limiting
- [ ] Document deployment

---

## ESTIMATED TIMELINE

- **Phase 1**: 2-3 hours (cleanup)
- **Phase 2**: 3-4 hours (schema + migration)
- **Phase 3**: 8-10 hours (AI systems)
- **Phase 4**: 4-5 hours (multi-TX)
- **Phase 5**: 6-8 hours (clan system)
- **Phase 6**: 6-8 hours (frontend)
- **Phase 7**: 3-4 hours (hardening)

**Total**: ~40-45 hours of development

---

## RISK MITIGATION

- **Backup database** before running migrations
- **Test all event flows** before production deployment
- **Run legacy + production in parallel** during transition
- **Gradual frontend rollout** with feature flags
- **Comprehensive monitoring** from day 1

---

## SUCCESS CRITERIA

- [ ] All duplicate event systems removed
- [ ] Zero event processing gaps during transition
- [ ] AI systems fully operational and validated
- [ ] Multi-TX quests generating 7+ transactions per quest
- [ ] Clan system supporting multiplayer cooperation
- [ ] Frontend realtime at <500ms latency
- [ ] 99.5% event delivery rate
- [ ] Zero treasury exploits in testing
- [ ] Hackathon-ready architecture documented
