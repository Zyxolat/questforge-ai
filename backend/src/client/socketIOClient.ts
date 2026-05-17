/**
 * Frontend Socket.IO Client Integration
 * Place this code in your frontend (React/Vue/Angular) application
 *
 * Installation:
 * npm install socket.io-client
 */

import { io, Socket } from 'socket.io-client';

interface QuestEvent {
  eventType: string;
  eventName: string;
  blockNumber: string;
  transactionHash: string;
  timestamp: string;
  data: Record<string, unknown>;
  chainQuestId?: string;
  playerWallet?: string;
  creatorWallet?: string;
}

class QuestForgeRealtimeClient {
  private socket: Socket | null = null;
  private isConnected = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  /**
   * Initialize connection to backend
   */
  connect(backendUrl: string = window.location.origin, userWallet?: string): void {
    if (this.isConnected) {
      console.warn('Socket already connected');
      return;
    }

    this.socket = io(backendUrl, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: this.maxReconnectAttempts,
      transports: ['websocket', 'polling']
    });

    // Connection event
    this.socket.on('connect', () => {
      console.log('✓ Connected to QuestForge backend');
      this.isConnected = true;
      this.reconnectAttempts = 0;

      // Subscribe to user-specific events
      if (userWallet) {
        this.subscribeToUser(userWallet);
      }
    });

    // Disconnection event
    this.socket.on('disconnect', (reason) => {
      console.warn('✗ Disconnected from backend:', reason);
      this.isConnected = false;
    });

    // Reconnection attempt
    this.socket.on('reconnect_attempt', () => {
      this.reconnectAttempts++;
      console.log(`Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
    });

    // Error handling
    this.socket.on('error', (error) => {
      console.error('Socket error:', error);
    });

    // Setup event listeners
    this.setupEventListeners();
  }

  /**
   * Setup all event listeners
   */
  private setupEventListeners(): void {
    if (!this.socket) return;

    // Quest created event
    this.socket.on('quest:created', (event: QuestEvent) => {
      console.log('🎯 New quest created:', event);
      this.handleQuestCreated(event);
    });

    // Quest started event
    this.socket.on('quest:started', (event: QuestEvent) => {
      console.log('▶️ Quest started:', event);
      this.handleQuestStarted(event);
    });

    // Proof submitted event
    this.socket.on('proof:submitted', (event: QuestEvent) => {
      console.log('📝 Proof submitted:', event);
      this.handleProofSubmitted(event);
    });

    // Reward claimed event
    this.socket.on('reward:claimed', (event: QuestEvent) => {
      console.log('🏆 Reward claimed:', event);
      this.handleRewardClaimed(event);
    });

    // NFT minted event
    this.socket.on('nft:minted', (event: QuestEvent) => {
      console.log('🎨 NFT minted:', event);
      this.handleNFTMinted(event);
    });

    // Treasury events
    this.socket.on('reward:reserved', (event: QuestEvent) => {
      console.log('💰 Reward reserved:', event);
    });

    this.socket.on('stake:locked', (event: QuestEvent) => {
      console.log('🔒 Stake locked:', event);
    });

    this.socket.on('reward:released', (event: QuestEvent) => {
      console.log('🔓 Reward released:', event);
    });

    this.socket.on('reward:paid', (event: QuestEvent) => {
      console.log('✅ Reward paid:', event);
    });

    this.socket.on('reward:refunded', (event: QuestEvent) => {
      console.log('↩️ Reward refunded:', event);
    });

    // Heartbeat
    setInterval(() => {
      if (this.isConnected && this.socket) {
        this.socket.emit('ping');
      }
    }, 30000);
  }

  /**
   * Subscribe to user-specific events
   */
  subscribeToUser(wallet: string): void {
    if (!this.socket || !wallet) return;

    this.socket.emit('subscribe:user', wallet.toLowerCase());
    console.log(`✓ Subscribed to user events for: ${wallet}`);
  }

  /**
   * Unsubscribe from user events
   */
  unsubscribeFromUser(wallet: string): void {
    if (!this.socket || !wallet) return;

    this.socket.emit('unsubscribe:user', wallet.toLowerCase());
    console.log(`✗ Unsubscribed from user events for: ${wallet}`);
  }

  /**
   * Handle quest created event
   */
  private handleQuestCreated(event: QuestEvent): void {
    // Update UI with new quest
    // Example: dispatch Redux action, update React state, emit custom event, etc.
    const { data, chainQuestId } = event;
    console.log(`New quest available: ${data.title}`, {
      questId: chainQuestId,
      reward: data.rewardAmount,
      xp: data.xpReward
    });
  }

  /**
   * Handle quest started event
   */
  private handleQuestStarted(event: QuestEvent): void {
    const { data } = event;
    console.log(`Quest started by ${data.player}`, {
      questId: data.questId,
      stake: data.stakeAmount
    });
  }

  /**
   * Handle proof submitted event
   */
  private handleProofSubmitted(event: QuestEvent): void {
    const { data } = event;
    console.log(`Proof submitted for quest ${data.questId}`);
    // Update UI to show proof is under verification
  }

  /**
   * Handle reward claimed event
   */
  private handleRewardClaimed(event: QuestEvent): void {
    const { data } = event;
    if (data.success) {
      console.log(`🎉 Quest completed! Earned ${data.rewardAmount} reward and ${data.xpReward} XP`);
    } else {
      console.log(`❌ Quest verification failed`);
    }
    // Update user profile with new XP/rewards
  }

  /**
   * Handle NFT minted event
   */
  private handleNFTMinted(event: QuestEvent): void {
    const { data } = event;
    console.log(`🎨 NFT minted: Token #${data.tokenId} for quest ${data.questId}`);
    // Add NFT to user's collection
  }

  /**
   * Disconnect from backend
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect();
      this.isConnected = false;
      console.log('Disconnected from QuestForge backend');
    }
  }

  /**
   * Check if connected
   */
  getIsConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Get socket instance (advanced usage)
   */
  getSocket(): Socket | null {
    return this.socket;
  }
}

// Export singleton instance
export const questForgeClient = new QuestForgeRealtimeClient();

/**
 * React Hook for using the client
 */
import { useEffect, useState } from 'react';

export function useQuestForgeEvents(userWallet?: string) {
  const [isConnected, setIsConnected] = useState(false);
  const [events, setEvents] = useState<QuestEvent[]>([]);

  useEffect(() => {
    // Connect on mount
    questForgeClient.connect(window.location.origin, userWallet);

    // Store events
    const handleEvent = (event: QuestEvent) => {
      setEvents((prev) => [event, ...prev].slice(0, 100)); // Keep last 100
    };

    if (questForgeClient.getSocket()) {
      const socket = questForgeClient.getSocket()!;
      socket.on('quest:created', handleEvent);
      socket.on('proof:submitted', handleEvent);
      socket.on('reward:claimed', handleEvent);
      socket.on('nft:minted', handleEvent);
      socket.on('connect', () => setIsConnected(true));
      socket.on('disconnect', () => setIsConnected(false));
    }

    return () => {
      // Cleanup
    };
  }, [userWallet]);

  return { isConnected, events, client: questForgeClient };
}

/**
 * Usage in React component:
 *
 * function QuestFeed() {
 *   const { userWallet } = useWallet();
 *   const { isConnected, events } = useQuestForgeEvents(userWallet);
 *
 *   return (
 *     <div>
 *       <div>Connection: {isConnected ? '✓' : '✗'}</div>
 *       {events.map((event) => (
 *         <div key={event.transactionHash}>
 *           {event.eventName}: {JSON.stringify(event.data)}
 *         </div>
 *       ))}
 *     </div>
 *   );
 * }
 */
