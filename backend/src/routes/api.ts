import { Request, Response, Router } from 'express';
import {
  generateQuest,
  getDailyMissions,
  getNPCDialogue,
  getActiveQuests,
  getRealtimeBootstrap,
  getQuestOrchestrationDiagnostics,
  registerOnchainQuest,
  submitProof,
  acceptQuest,
  updateChainQuestId,
  getQuestById,
  createOnchainQuest
} from '../controllers/questController';
import { getPlayerStats, getProgression, claimDailyLoginBonus } from '../controllers/userController';
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

function authMethodNotAllowed(allowedMethod: 'POST') {
  return (_req: Request, res: Response) => {
    res.set('Allow', allowedMethod);
    res.status(405).json({
      error: {
        code: 'AUTH_METHOD_NOT_ALLOWED',
        message: `Use ${allowedMethod} for this authentication endpoint`
      },
      action: 'none'
    });
  };
}

apiRouter.post('/auth/nonce', authNonceLimiter, createAuthNonce);
apiRouter.post('/auth/verify', authVerifyLimiter, verifyAuthSignature);
apiRouter.post('/auth/refresh', authRefreshLimiter, refreshAuthenticatedSession);
apiRouter.get('/auth/verify', authMethodNotAllowed('POST'));
apiRouter.get('/auth/refresh', authMethodNotAllowed('POST'));
apiRouter.get('/auth/me', requireAuth, getAuthenticatedSession);
apiRouter.post('/auth/logout', logoutSession);

apiRouter.post('/quests/generate', requireAuth, questGenerationLimiter, generateQuest);
apiRouter.post('/quests/:questId/accept', requireAuth, acceptQuest);
apiRouter.post('/quests/:questId/create-onchain', requireAuth, createOnchainQuest);
apiRouter.get('/quests/:questId', requireAuth, getQuestById);
apiRouter.patch('/quests/:questId/chain-quest-id', requireAuth, updateChainQuestId);
apiRouter.post('/quests/register-onchain', requireAuth, registerOnchainQuest);
apiRouter.post('/quests/submit-proof', requireAuth, proofSubmissionLimiter, submitProof);
apiRouter.get('/quests/daily', getDailyMissions);
apiRouter.get('/quests/active', requireAuth, getActiveQuestsLimiter, getActiveQuests);
apiRouter.get('/realtime/bootstrap', requireAuth, getRealtimeBootstrap);
apiRouter.get('/quests/orchestration/diagnostics', getQuestOrchestrationDiagnostics);
apiRouter.get('/npc/dialogue', getNPCDialogue);
apiRouter.post('/player/daily-bonus', requireAuth, claimDailyLoginBonus);
apiRouter.get('/player/stats', getPlayerStats);
apiRouter.get('/player/progression', getProgression);
apiRouter.get('/nft/metadata', getNFTMetadata);
