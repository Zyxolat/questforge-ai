import { Prisma } from '@prisma/client';
import { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient, type RedisClientType } from 'redis';
import { logger } from './logger';
import { env } from '../config/env';

export interface BroadcastEvent {
  eventType: string;
  eventName: string;
  blockNumber: bigint;
  transactionHash: string;
  timestamp: Date;
  data: Prisma.JsonValue;
  chainQuestId?: bigint;
  playerWallet?: string;
  creatorWallet?: string;
}

class ProductionWebSocketBroadcaster {
  private io: SocketIOServer | null = null;
  private pubClient: RedisClientType | null = null;
  private subClient: RedisClientType | null = null;
  private connectedClients = 0;

  /**
   * Initialize Socket.IO with Redis adapter for multi-instance support
   */
  async initialize(httpServer: HttpServer): Promise<SocketIOServer | null> {
    if (!env.WEBSOCKET_ENABLED) {
      logger.warn('[WS] Disabled');
      return null;
    }

    try {
      this.io = new SocketIOServer(httpServer, {
        cors: {
          origin: env.CORS_ORIGINS,
          credentials: true
        },
        transports: ['websocket', 'polling'],
        pingInterval: 25000,
        pingTimeout: 60000
      });

      // Setup Redis adapter for multi-instance support
      if (env.REDIS_URL) {
        try {
          const redisUrl = new URL(env.REDIS_URL);
          const redisConfig = {
            host: redisUrl.hostname || 'localhost',
            port: redisUrl.port ? parseInt(redisUrl.port) : 6379,
            password: redisUrl.password || undefined
          };

          this.pubClient = createClient(redisConfig);
          this.subClient = this.pubClient.duplicate();

          await this.pubClient.connect();
          await this.subClient.connect();

          this.io.adapter(createAdapter(this.pubClient, this.subClient));

          logger.info('[WS] Redis adapter initialized for multi-instance sync');
        } catch (error) {
          logger.error('[WS] Failed to initialize Redis adapter', { error: (error as Error).message });
          // Continue without adapter for single-instance fallback
        }
      }

      // Connection handling
      this.io.on('connection', (socket) => {
        this.connectedClients++;
        logger.debug('[WS] Client connected', {
          socketId: socket.id,
          totalClients: this.connectedClients
        });

        socket.on('disconnect', () => {
          this.connectedClients = Math.max(0, this.connectedClients - 1);
          logger.debug('[WS] Client disconnected', {
            socketId: socket.id,
            totalClients: this.connectedClients
          });
        });

        socket.on('subscribe:user', (wallet: string) => {
          if (!wallet || typeof wallet !== 'string') {
            socket.emit('error', 'Invalid wallet');
            return;
          }

          const roomId = `user:${wallet.toLowerCase()}`;
          socket.join(roomId);
          logger.debug('[WS] User subscribed', { socketId: socket.id, roomId });
        });

        socket.on('unsubscribe:user', (wallet: string) => {
          if (!wallet || typeof wallet !== 'string') return;
          const roomId = `user:${wallet.toLowerCase()}`;
          socket.leave(roomId);
          logger.debug('[WS] User unsubscribed', { socketId: socket.id, roomId });
        });

        socket.on('ping', () => {
          socket.emit('pong');
        });
      });

      logger.info('[WS] Server initialized');
      return this.io;
    } catch (error) {
      logger.error('[WS] Failed to initialize', { error: (error as Error).message });
      return null;
    }
  }

  getIO(): SocketIOServer | null {
    return this.io;
  }

  /**
   * Broadcast to all connected clients
   */
  broadcastToAll(event: string, data: BroadcastEvent): void {
    if (!this.io) return;

    this.io.emit(event, {
      ...data,
      timestamp: data.timestamp.toISOString(),
      blockNumber: data.blockNumber.toString()
    });

    logger.debug('[WS] Broadcasted to all', {
      event,
      clientsCount: this.connectedClients
    });
  }

  /**
   * Broadcast to player room
   */
  broadcastToPlayer(playerWallet: string, event: string, data: BroadcastEvent): void {
    if (!this.io) return;

    const roomId = `user:${playerWallet.toLowerCase()}`;
    this.io.to(roomId).emit(event, {
      ...data,
      timestamp: data.timestamp.toISOString(),
      blockNumber: data.blockNumber.toString()
    });

    logger.debug('[WS] Broadcasted to player', { roomId, event });
  }

  /**
   * Broadcast to creator room
   */
  broadcastToCreator(creatorWallet: string, event: string, data: BroadcastEvent): void {
    if (!this.io) return;

    const roomId = `creator:${creatorWallet.toLowerCase()}`;
    this.io.to(roomId).emit(event, {
      ...data,
      timestamp: data.timestamp.toISOString(),
      blockNumber: data.blockNumber.toString()
    });

    logger.debug('[WS] Broadcasted to creator', { roomId, event });
  }

  /**
   * Broadcast quest event
   */
  broadcastQuestEvent(event: BroadcastEvent): void {
    if (!this.io) return;

    const eventMap: Record<string, string> = {
      quest_created: 'quest:created',
      quest_started: 'quest:started',
      proof_submitted: 'proof:submitted',
      reward_claimed: 'reward:claimed',
      nft_minted: 'nft:minted',
      reward_reserved: 'reward:reserved',
      stake_locked: 'stake:locked',
      reward_released: 'reward:released',
      reward_paid: 'reward:paid',
      reward_refunded: 'reward:refunded'
    };

    const socketEvent = eventMap[event.eventType] || `event:${event.eventType}`;

    this.broadcastToAll(socketEvent, event);

    if (event.playerWallet) {
      this.broadcastToPlayer(event.playerWallet, socketEvent, event);
    }

    if (event.creatorWallet && event.creatorWallet !== event.playerWallet) {
      this.broadcastToCreator(event.creatorWallet, socketEvent, event);
    }

    logger.debug('[WS] Quest event broadcasted', {
      eventType: event.eventType,
      socketEvent
    });
  }

  getConnectedClientsCount(): number {
    return this.connectedClients;
  }

  getStats() {
    return {
      connectedClients: this.connectedClients,
      enabled: env.WEBSOCKET_ENABLED && this.io !== null,
      multiInstance: this.pubClient !== null
    };
  }

  async cleanup(): Promise<void> {
    try {
      if (this.io) {
        await this.io.close();
        this.io = null;
      }
      if (this.pubClient) {
        await this.pubClient.quit();
        this.pubClient = null;
      }
      if (this.subClient) {
        await this.subClient.quit();
        this.subClient = null;
      }
      logger.info('[WS] Cleaned up');
    } catch (error) {
      logger.error('[WS] Cleanup error', { error: (error as Error).message });
    }
  }
}

export const productionWebSocketBroadcaster = new ProductionWebSocketBroadcaster();
