import { Router } from 'express';
import {
  generateQuest,
  getDailyMissions,
  getNPCDialogue,
  getActiveQuests,
  submitProof
} from '../controllers/questController';
import { getPlayerStats, getProgression } from '../controllers/userController';
import { getNFTMetadata } from '../controllers/metadataController';
import {
  createAuthNonce,
  getAuthenticatedSession,
  logoutSession,
  refreshAuthenticatedSession,
  verifyAuthSignature
} from '../controllers/authController';
import { requireAuth } from '../middleware/auth';
import {
  authNonceLimiter,
  authRefreshLimiter,
  authVerifyLimiter,
  getActiveQuestsLimiter,
  proofSubmissionLimiter,
  questGenerationLimiter
} from '../middleware/rateLimits';

export const apiRouter = Router();

apiRouter.post('/auth/nonce', authNonceLimiter, createAuthNonce);
apiRouter.post('/auth/verify', authVerifyLimiter, verifyAuthSignature);
apiRouter.post('/auth/refresh', authRefreshLimiter, refreshAuthenticatedSession);
apiRouter.get('/auth/me', requireAuth, getAuthenticatedSession);
apiRouter.post('/auth/logout', logoutSession);

apiRouter.post('/quests/generate', requireAuth, questGenerationLimiter, generateQuest);
apiRouter.post('/quests/submit-proof', requireAuth, proofSubmissionLimiter, submitProof);
apiRouter.get('/quests/daily', getDailyMissions);
apiRouter.get('/quests/active', requireAuth, getActiveQuestsLimiter, getActiveQuests);
apiRouter.get('/npc/dialogue', getNPCDialogue);
apiRouter.get('/player/stats', getPlayerStats);
apiRouter.get('/player/progression', getProgression);
apiRouter.get('/nft/metadata', getNFTMetadata);
