import { Router } from 'express';
import {
  generateQuest,
  validateQuest,
  startQuest,
  recordTransaction,
  submitQuest,
  getDailyMissions,
  getNPCDialogue,
  getActiveQuests
} from '../controllers/questController';
import { getPlayerStats, getProgression } from '../controllers/userController';
import { getNFTMetadata } from '../controllers/metadataController';

export const apiRouter = Router();

apiRouter.post('/quests/generate', generateQuest);
apiRouter.post('/quests/start', startQuest);
apiRouter.post('/quests/record', recordTransaction);
apiRouter.post('/quests/submit', submitQuest);
apiRouter.post('/quests/validate', validateQuest);
apiRouter.get('/quests/daily', getDailyMissions);
apiRouter.get('/quests/active', getActiveQuests);
apiRouter.get('/npc/dialogue', getNPCDialogue);
apiRouter.get('/player/stats', getPlayerStats);
apiRouter.get('/player/progression', getProgression);
apiRouter.get('/nft/metadata', getNFTMetadata);
