export {};

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        wallet: string;
        sessionId: string;
        expiresAt: Date;
        accessTokenExpiresAt: Date;
        user: {
          id: string;
          username: string | null;
          wallet: string;
          xp: number;
          level: number;
          questCount: number;
          streak: number;
          onchainActions: number;
        };
      };
    }
  }
}
