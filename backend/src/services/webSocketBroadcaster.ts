import { Prisma } from '@prisma/client';
import { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
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

class WebSocketBroadcaster {
  private io: SocketIOServer | null = null;
  private connectedClients = 0;

  /**
   * Initialize Socket.IO server
   */
  initialize(httpServer: HttpServer): SocketIOServer | null {
    if (!env.WEBSOCKET_ENABLED) {
      logger.warn('WebSocket is disabled');
      return null;
    }

    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: env.CORS_ORIGINS,
        credentials: true
      },
      transports: ['websocket', 'polling'],
      pingInterval: 25000,
      pingTimeout: 60000
    });

    // Connection handling
    this.io.on('connection', (socket) => {
      this.connectedClients++;
      logger.debug('Client connected', {
        socketId: socket.id,
        totalClients: this.connectedClients
      });

      // Handle disconnection
      socket.on('disconnect', () => {
        this.connectedClients = Math.max(0, this.connectedClients - 1);
        logger.debug('Client disconnected', {
          socketId: socket.id,
          totalClients: this.connectedClients
        });
      });

      // Handle subscription to user room
      socket.on('subscribe:user', (wallet: string) => {
        if (!wallet || typeof wallet !== 'string') {
          socket.emit('error', 'Invalid wallet');
          return;
        }

        const roomId = `user:${wallet.toLowerCase()}`;
        socket.join(roomId);
        logger.debug('User subscribed', { socketId: socket.id, roomId });
      });

      // Handle unsubscription
      socket.on('unsubscribe:user', (wallet: string) => {
        if (!wallet || typeof wallet !== 'string') return;

        const roomId = `user:${wallet.toLowerCase()}`;
        socket.leave(roomId);
        logger.debug('User unsubscribed', { socketId: socket.id, roomId });
      });

      // Heartbeat
      socket.on('ping', () => {
        socket.emit('pong');
      });
    });

    logger.info('WebSocket server initialized');
    return this.io;
  }

  /**
   * Get Socket.IO instance
   */
  getIO(): SocketIOServer | null {
    return this.io;
  }

  /**
   * Broadcast event to all connected clients
   */
  broadcastToAll(event: string, data: BroadcastEvent): void {
    if (!this.io) return;

    this.io.emit(event, {
      ...data,
      timestamp: data.timestamp.toISOString(),
      blockNumber: data.blockNumber.toString()
    });

    logger.debug('Broadcasted to all', {
      event,
      clientsCount: this.connectedClients
    });
  }

  /**
   * Broadcast event to player-specific room
   */
  broadcastToPlayer(playerWallet: string, event: string, data: BroadcastEvent): void {
    if (!this.io) return;

    const roomId = `user:${playerWallet.toLowerCase()}`;
    this.io.to(roomId).emit(event, {
      ...data,
      timestamp: data.timestamp.toISOString(),
      blockNumber: data.blockNumber.toString()
    });

    logger.debug('Broadcasted to player', {
      roomId,
      event
    });
  }

  /**
   * Broadcast event to creator-specific room
   */
  broadcastToCreator(creatorWallet: string, event: string, data: BroadcastEvent): void {
    if (!this.io) return;

    const roomId = `creator:${creatorWallet.toLowerCase()}`;
    this.io.to(roomId).emit(event, {
      ...data,
      timestamp: data.timestamp.toISOString(),
      blockNumber: data.blockNumber.toString()
    });

    logger.debug('Broadcasted to creator', {
      roomId,
      event
    });
  }

  /**
   * Broadcast quest-related event
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

    // Broadcast to all clients
    this.broadcastToAll(socketEvent, event);

    // Broadcast to specific users
    if (event.playerWallet) {
      this.broadcastToPlayer(event.playerWallet, socketEvent, event);
    }

    if (event.creatorWallet && event.creatorWallet !== event.playerWallet) {
      this.broadcastToCreator(event.creatorWallet, socketEvent, event);
    }

    logger.debug('Quest event broadcasted', {
      eventType: event.eventType,
      socketEvent,
      playersAffected: [event.playerWallet, event.creatorWallet]
        .filter(Boolean)
        .length
    });
  }

  /**
   * Get connected clients count
   */
  getConnectedClientsCount(): number {
    return this.connectedClients;
  }

  /**
   * Get broadcaster stats
   */
  getStats() {
    return {
      connectedClients: this.connectedClients,
      enabled: env.WEBSOCKET_ENABLED && this.io !== null
    };
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    if (this.io) {
      await this.io.close();
      this.io = null;
      logger.info('WebSocket server closed');
    }
  }
}

export const webSocketBroadcaster = new WebSocketBroadcaster();
