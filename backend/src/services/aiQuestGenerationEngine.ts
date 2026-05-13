import type { Prisma, User } from '@prisma/client';
import { aiDifficultyEngine } from './aiDifficultyEngine';
import { aiRewardEngine } from './aiRewardEngine';
import { aiMemoryGraph } from './aiMemoryGraph';
import { calculateStreakMultiplier } from './antiAbuse';
import { factionInfluenceEngine } from './factionInfluenceEngine';
import { normalizeWallet, prisma } from './chain';
import { npcRelationshipEngine } from './npcRelationshipEngine';
import { playerNarrativeState } from './playerNarrativeState';
import { questNarrativeEngine } from './questNarrativeEngine';
import { questValidationEngine } from './questValidationEngine';
import type { PlayerQuestProfile, QuestNpcDraft, ValidatedQuestOutput } from './questOrchestrationTypes';
import { realtimeEventPublisher } from './realtimeEventPublisher';
import { worldStateCoordinator } from './worldStateCoordinator';

type QuestGenerationResult = {
  quest: ValidatedQuestOutput & {
    id: string;
    expiresAt: Date;
    status: 'AVAILABLE';
  };
  difficultyProfile: Awaited<ReturnType<typeof aiDifficultyEngine.calculateDifficulty>>;
  rewardProfile: Awaited<ReturnType<typeof aiRewardEngine.calculateRewardProfile>>;
  streakMultiplier: number;
  orchestrationDiagnostics: ReturnType<AIQuestGenerationEngine['getDiagnostics']>;
};

type UserWithRelations = User & {
  agent: {
    id: string;
    memoryGraph: Prisma.JsonValue;
  } | null;
  clan: {
    id: string;
    name: string;
  } | null;
};

class AIQuestGenerationEngine {
  private diagnostics = {
    generatedCount: 0,
    escalatedCount: 0,
    validationFailures: 0,
    lastGeneratedQuestId: null as string | null,
    lastGeneratedAt: null as string | null
  };

  async generateQuest(input: { wallet: string; chain: string }): Promise<QuestGenerationResult> {
    const wallet = normalizeWallet(input.wallet);
    await worldStateCoordinator.initialize();

    const user = await prisma.user.findUnique({
      where: { wallet },
      include: {
        agent: {
          select: {
            id: true,
            memoryGraph: true
          }
        },
        clan: {
          select: {
            id: true,
            name: true
          }
        }
      }
    });

    if (!user) {
      throw new Error('User not found for quest generation');
    }

    const [difficultyProfile, worldState] = await Promise.all([
      aiDifficultyEngine.calculateDifficulty(user.id),
      worldStateCoordinator.refreshWorldState({ trigger: 'quest_generation' })
    ]);

    const streakMultiplier = calculateStreakMultiplier(user.streak, user.streakDecayFactor);
    const rewardProfile = await aiRewardEngine.calculateRewardProfile({
      userId: user.id,
      difficulty: difficultyProfile.difficulty,
      stakeAmount: difficultyProfile.recommendedStake,
      streakMultiplier
    });

    const playerProfile = await this.buildPlayerProfile(user);
    const npc = await this.selectQuestNpc(user, worldState, playerProfile);

    const narrative = await questNarrativeEngine.generateQuestNarrative({
      wallet,
      chain: input.chain,
      difficulty: difficultyProfile.difficulty,
      rewardAmount: rewardProfile.rewardAmount,
      stakeAmount: difficultyProfile.recommendedStake,
      playerProfile,
      worldState,
      npc
    });

    let validated: ValidatedQuestOutput;
    try {
      validated = questValidationEngine.validateGeneratedQuest({
        wallet,
        chain: input.chain,
        difficulty: difficultyProfile.difficulty,
        stakeBounds: difficultyProfile.stakeBounds,
        rewardBounds: difficultyProfile.rewardBounds,
        recommendedStake: difficultyProfile.recommendedStake,
        rewardAmount: rewardProfile.rewardAmount,
        xpReward: rewardProfile.xpReward,
        estimatedDurationSeconds: difficultyProfile.estimatedDuration,
        worldState,
        playerProfile,
        narrative,
        difficultyReasoning: difficultyProfile.reasoning,
        rewardReasoning: rewardProfile.reasoning,
        worldMultiplier: rewardProfile.worldMultiplier,
        treasuryCap: rewardProfile.treasuryCap,
        activeWorldModifiers: rewardProfile.activeWorldModifiers,
        agentId: difficultyProfile.agentId
      });
    } catch (error) {
      this.diagnostics.validationFailures += 1;
      throw error;
    }

    const persistedQuest = await prisma.$transaction(async (tx) => {
      const created = await tx.quest.create({
        data: {
          title: validated.title,
          description: validated.description,
          metadata: validated.metadata as Prisma.InputJsonValue,
          difficulty: validated.difficulty,
          questType: validated.questType,
          objective: validated.objective,
          lore: validated.lore,
          stakeAmount: validated.stakeAmount,
          rewardAmount: validated.rewardAmount,
          xpReward: validated.xpReward,
          maxRewardAmount: difficultyProfile.rewardBounds.max,
          minStakeAmount: difficultyProfile.stakeBounds.min,
          maxStakeAmount: difficultyProfile.stakeBounds.max,
          status: 'AVAILABLE',
          creator: wallet,
          playerId: user.id,
          npcGiverId: validated.npc.npcId,
          transactionCount: validated.transactionCount,
          requiredTxTypes: validated.requiredTxTypes,
          isEventQuest: validated.isEventQuest,
          expiresAt: new Date(Date.now() + validated.durationSeconds * 1000)
        }
      });

      await tx.questHistory.create({
        data: {
          userId: user.id,
          questId: created.id,
          action: 'GENERATED'
        }
      });

      await this.persistNPCInteraction(tx, {
        userId: user.id,
        wallet,
        npc,
        worldStateVersion: validated.worldStateVersion,
        openingDialogue: validated.npc.openingDialogue,
        questTitle: validated.title,
        questId: created.id
      });

      if (difficultyProfile.agentId) {
        await this.persistAgentMemory(tx, {
          agentId: difficultyProfile.agentId,
          questId: created.id,
          wallet,
          questTitle: validated.title,
          worldStateVersion: validated.worldStateVersion,
          factionId: validated.faction.primaryFactionId,
          npcId: validated.npc.npcId,
          difficulty: validated.difficulty,
          riskLevel: validated.riskLevel
        });

        await tx.agentIdentity.update({
          where: { id: difficultyProfile.agentId },
          data: {
            worldStateVersion: validated.worldStateVersion
          }
        });
      }

      return created;
    });

    const escalated = this.isEscalatedQuest(playerProfile, difficultyProfile.difficulty);
    await this.projectPersistentMemory({
      userId: user.id,
      wallet,
      questId: persistedQuest.id,
      npcId: validated.npc.npcId,
      factionId: validated.faction.primaryFactionId,
      factionName: validated.faction.primaryFactionName,
      worldStateVersion: validated.worldStateVersion,
      title: validated.title,
      escalated,
      clanId: user.clanId
    });
    await this.emitQuestEvents({
      wallet,
      questId: persistedQuest.id,
      orchestrationId: validated.orchestrationId,
      validated,
      escalated,
      clanId: user.clanId
    });

    this.diagnostics.generatedCount += 1;
    if (escalated) {
      this.diagnostics.escalatedCount += 1;
    }
    this.diagnostics.lastGeneratedQuestId = persistedQuest.id;
    this.diagnostics.lastGeneratedAt = new Date().toISOString();

    return {
      quest: {
        ...validated,
        id: persistedQuest.id,
        expiresAt: persistedQuest.expiresAt,
        status: 'AVAILABLE'
      },
      difficultyProfile,
      rewardProfile,
      streakMultiplier: Number(streakMultiplier.toFixed(2)),
      orchestrationDiagnostics: this.getDiagnostics()
    };
  }

  getDiagnostics() {
    return { ...this.diagnostics };
  }

  private async buildPlayerProfile(user: UserWithRelations): Promise<PlayerQuestProfile> {
    const [recentQuests, recentConversations, recentNpcMemories, transactionCount] = await Promise.all([
      prisma.quest.findMany({
        where: { playerId: user.id },
        select: {
          title: true,
          objective: true,
          difficulty: true,
          status: true,
          metadata: true,
          npcGiver: {
            select: {
              name: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        take: 8
      }),
      prisma.nPCConversation.findMany({
        where: { userId: user.id },
        include: {
          npc: {
            select: {
              name: true
            }
          }
        },
        orderBy: { updatedAt: 'desc' },
        take: 6
      }),
      prisma.nPCMemory.findMany({
        where: { wallet: user.wallet },
        include: {
          npc: {
            select: {
              name: true
            }
          }
        },
        orderBy: [{ importanceScore: 'desc' }, { updatedAt: 'desc' }],
        take: 6
      }),
      prisma.transaction.count({
        where: { wallet: user.wallet }
      })
    ]);

    const recentFactionIds = recentQuests
      .map((quest) => this.readFactionIdFromMetadata(quest.metadata))
      .filter((value): value is string => Boolean(value));

    const relationshipSummary = [
      `successes=${recentQuests.filter((quest) => quest.status === 'VERIFIED').length}`,
      `betrayals=${recentQuests.filter((quest) => quest.status === 'FAILED').length}`,
      `guild=${user.clan?.name ?? 'unaffiliated'}`,
      `agent=${user.agent?.id ?? 'unbound'}`,
      ...recentNpcMemories.map((memory) => `${memory.npc.name}:${memory.memory}`)
    ].slice(0, 6);

    return {
      userId: user.id,
      wallet: user.wallet,
      username: user.username,
      level: user.level,
      xp: user.xp,
      streak: user.streak,
      onchainActions: user.onchainActions,
      clanId: user.clanId,
      agentId: user.agentId,
      walletHistoryScore: Number(Math.min(1, (transactionCount + user.onchainActions) / 150).toFixed(3)),
      questHistory: {
        recentQuestTitles: recentQuests.map((quest) => quest.title).filter(Boolean).slice(0, 5),
        recentObjectives: recentQuests.map((quest) => quest.objective || 'submit proof').slice(0, 5),
        recentNpcNames: recentConversations.map((conversation) => conversation.npc.name).slice(0, 4),
        recentFactionIds: recentFactionIds.slice(0, 4),
        recentDifficultyAverage:
          recentQuests.length > 0
            ? Number(
                (
                  recentQuests.reduce((sum, quest) => sum + quest.difficulty, 0) /
                  recentQuests.length
                ).toFixed(2)
              )
            : 2.5,
        verifiedCount: recentQuests.filter((quest) => quest.status === 'VERIFIED').length,
        failedCount: recentQuests.filter((quest) => quest.status === 'FAILED').length,
        questStreak: user.streak
      },
      relationshipSummary
    };
  }

  private async selectQuestNpc(
    user: UserWithRelations,
    worldState: Awaited<ReturnType<typeof worldStateCoordinator.getCurrentWorldState>>,
    profile: PlayerQuestProfile
  ): Promise<QuestNpcDraft> {
    const primaryFaction = worldState.factions[0];
    const npcType = primaryFaction.status === 'dominant' ? 'faction_leader' : 'quest_giver';

    const existingNpc =
      (await prisma.nPC.findFirst({
        where: {
          OR: [
            { type: npcType },
            { type: 'guildmaster' },
            { type: 'quest_giver' }
          ]
        },
        orderBy: [{ lastInteractionAt: 'desc' }, { reputation: 'desc' }]
      })) ??
      (await prisma.nPC.create({
        data: {
          type: npcType,
          name: primaryFaction.name.includes('Forgeguard') ? 'Marshal Ilyra' : 'Archivist Neme',
          personality: {
            factionId: primaryFaction.id,
            traits: worldState.npcTones,
            role: npcType
          },
          currentLocation: 'forge-hall',
          reputation: 0.35,
          lastInteractionAt: new Date()
        }
      }));

    const existingMemory = await prisma.nPCMemory.findFirst({
      where: {
        npcId: existingNpc.id,
        wallet: user.wallet
      },
      orderBy: { updatedAt: 'desc' }
    });

    const memoryReferences = existingMemory
      ? [existingMemory.memory]
      : [
          `player successes=${profile.questHistory.verifiedCount}`,
          `guild affiliation=${user.clan?.name ?? 'none'}`,
          `quest streak=${user.streak}`
        ];

    return {
      npcId: existingNpc.id,
      name: existingNpc.name,
      type: existingNpc.type,
      role: typeof existingNpc.personality === 'object' && existingNpc.personality && !Array.isArray(existingNpc.personality)
        ? String((existingNpc.personality as Record<string, unknown>).role ?? 'quest steward')
        : 'quest steward',
      relationshipScore: Number(
        Math.min(1, Math.max(-1, (existingMemory?.importanceScore ?? 0.4) - profile.questHistory.failedCount * 0.05)).toFixed(3)
      ),
      personalitySummary: this.describeNpcPersonality(existingNpc.personality),
      openingDialogue: '',
      memoryReferences
    };
  }

  private async persistNPCInteraction(
    tx: Prisma.TransactionClient,
    input: {
      userId: string;
      wallet: string;
      npc: QuestNpcDraft;
      worldStateVersion: number;
      openingDialogue: string;
      questTitle: string;
      questId: string;
    }
  ) {
    await tx.nPC.update({
      where: { id: input.npc.npcId },
      data: {
        lastInteractionAt: new Date()
      }
    });

    await tx.nPCConversation.create({
      data: {
        userId: input.userId,
        npcId: input.npc.npcId,
        messages: [
          { role: 'npc', content: input.openingDialogue },
          { role: 'system', content: `Quest generated: ${input.questTitle}` }
        ]
      }
    });

    const memoryText = `successes and streak observed; quest=${input.questTitle}; worldStateVersion=${input.worldStateVersion}`;
    const existingMemory = await tx.nPCMemory.findFirst({
      where: {
        npcId: input.npc.npcId,
        wallet: input.wallet
      }
    });
    const embedding = this.buildEmbedding([
      input.worldStateVersion,
      input.npc.relationshipScore,
      input.questId.length,
      input.questTitle.length
    ]);

    if (existingMemory) {
      await tx.nPCMemory.update({
        where: { id: existingMemory.id },
        data: {
          memory: memoryText,
          embedding,
          importanceScore: Number(Math.min(2, existingMemory.importanceScore + 0.15).toFixed(3)),
          interactionCount: existingMemory.interactionCount + 1
        }
      });
    } else {
      await tx.nPCMemory.create({
        data: {
          npcId: input.npc.npcId,
          wallet: input.wallet,
          memory: memoryText,
          embedding,
          importanceScore: 0.75,
          interactionCount: 1
        }
      });
    }
  }

  private async persistAgentMemory(
    tx: Prisma.TransactionClient,
    input: {
      agentId: string;
      questId: string;
      wallet: string;
      questTitle: string;
      worldStateVersion: number;
      factionId: string;
      npcId: string;
      difficulty: number;
      riskLevel: string;
    }
  ) {
    await tx.agentMemory.create({
      data: {
        agentId: input.agentId,
        questId: input.questId,
        memoryType: 'quest_generation',
        memoryData: {
          wallet: input.wallet,
          questTitle: input.questTitle,
          worldStateVersion: input.worldStateVersion,
          factionId: input.factionId,
          npcId: input.npcId,
          difficulty: input.difficulty,
          riskLevel: input.riskLevel
        },
        embedding: this.buildEmbedding([
          input.worldStateVersion,
          input.difficulty,
          input.questTitle.length,
          input.riskLevel.length
        ])
      }
    });
  }

  private async projectPersistentMemory(input: {
    userId: string;
    wallet: string;
    questId: string;
    npcId: string;
    factionId: string;
    factionName: string;
    worldStateVersion: number;
    title: string;
    escalated: boolean;
    clanId: string | null;
  }) {
    const summary = input.escalated
      ? `A more dangerous mission was entrusted to the player: ${input.title}.`
      : `A new mission entered the player's long-term story: ${input.title}.`;

    await aiMemoryGraph.recordMemory({
      replayKey: `quest-generation:${input.questId}`,
      memoryType: 'quest_generation',
      summary,
      metadata: {
        questId: input.questId,
        worldStateVersion: input.worldStateVersion,
        escalated: input.escalated,
        factionId: input.factionId
      },
      userId: input.userId,
      npcId: input.npcId,
      questId: input.questId,
      importanceScore: input.escalated ? 1.6 : 1.2
    });

    await npcRelationshipEngine.updateRelationship({
      userId: input.userId,
      wallet: input.wallet,
      npcId: input.npcId,
      questId: input.questId,
      eventType: 'quest_generation',
      summary,
      trustDelta: input.escalated ? 0.12 : 0.08,
      metadata: {
        worldStateVersion: input.worldStateVersion,
        questId: input.questId
      }
    });

    await factionInfluenceEngine.applyInfluence({
      userId: input.userId,
      factionId: input.factionId,
      factionName: input.factionName,
      questId: input.questId,
      eventType: 'quest_generation',
      standingDelta: input.escalated ? 5 : 3,
      summary,
      flags: ['quest_generation', ...(input.clanId ? ['clan_member'] : [])],
      metadata: {
        questId: input.questId,
        worldStateVersion: input.worldStateVersion
      }
    });

    await playerNarrativeState.projectForUser(input.userId);
  }

  private async emitQuestEvents(input: {
    wallet: string;
    questId: string;
    orchestrationId: string;
    validated: ValidatedQuestOutput;
    escalated: boolean;
    clanId: string | null;
  }) {
    const payload = {
      questId: input.questId,
      orchestrationId: input.orchestrationId,
      wallet: input.wallet,
      difficulty: input.validated.difficulty,
      riskLevel: input.validated.riskLevel,
      npc: {
        id: input.validated.npc.npcId,
        name: input.validated.npc.name
      },
      faction: input.validated.faction,
      worldStateVersion: input.validated.worldStateVersion,
      transactionCount: input.validated.transactionCount,
      timestamp: new Date().toISOString()
    };

    await realtimeEventPublisher.publish({
      replayKey: `quest-generated:${input.questId}`,
      eventName: 'quest:generated',
      sourceType: 'quest_generation',
      sourceId: input.questId,
      payload,
      scopes: [
        { type: 'global', key: 'global' },
        { type: 'user', key: input.wallet },
        ...(input.clanId ? [{ type: 'clan' as const, key: input.clanId }] : [])
      ]
    });

    await realtimeEventPublisher.publish({
      replayKey: `npc-interaction:${input.questId}`,
      eventName: 'npc:interaction-updated',
      sourceType: 'quest_generation',
      sourceId: input.questId,
      payload: {
        wallet: input.wallet,
        npcId: input.validated.npc.npcId,
        npcName: input.validated.npc.name,
        relationshipScore: input.validated.npc.relationshipScore,
        timestamp: payload.timestamp
      },
      scopes: [
        { type: 'user', key: input.wallet },
        { type: 'global', key: 'global' }
      ]
    });

    if (input.escalated) {
      await realtimeEventPublisher.publish({
        replayKey: `quest-escalated:${input.questId}`,
        eventName: 'quest:escalated',
        sourceType: 'quest_generation',
        sourceId: input.questId,
        payload,
        scopes: [
          { type: 'global', key: 'global' },
          { type: 'user', key: input.wallet },
          ...(input.clanId ? [{ type: 'clan' as const, key: input.clanId }] : [])
        ]
      });
    }
  }

  private isEscalatedQuest(profile: PlayerQuestProfile, difficulty: number) {
    return difficulty > Math.ceil(profile.questHistory.recentDifficultyAverage);
  }

  private readFactionIdFromMetadata(metadata: Prisma.JsonValue): string | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return null;
    }

    const orchestration = (metadata as Record<string, unknown>).orchestration;
    if (!orchestration || typeof orchestration !== 'object' || Array.isArray(orchestration)) {
      return null;
    }

    const faction = (orchestration as Record<string, unknown>).faction;
    if (!faction || typeof faction !== 'object' || Array.isArray(faction)) {
      return null;
    }

    const value = (faction as Record<string, unknown>).primaryFactionId;
    return typeof value === 'string' ? value : null;
  }

  private describeNpcPersonality(personality: Prisma.JsonValue) {
    if (!personality || typeof personality !== 'object' || Array.isArray(personality)) {
      return 'measured and observant';
    }

    const data = personality as Record<string, unknown>;
    const traits = Array.isArray(data.traits) ? data.traits.filter((trait): trait is string => typeof trait === 'string') : [];
    const role = typeof data.role === 'string' ? data.role : 'quest steward';
    return [role, ...traits].slice(0, 3).join(', ');
  }

  private buildEmbedding(values: number[]) {
    return values.map((value, index) => Number(Math.max(0, Math.min(1, value / (index + 5))).toFixed(6)));
  }
}

export const aiQuestGenerationEngine = new AIQuestGenerationEngine();
export type { QuestGenerationResult };
