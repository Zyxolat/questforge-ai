import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { performHealthCheck } from './config/production';
import { globalLimiter } from './middleware/rateLimits';
import { apiRouter } from './routes/api';
import { startQuestIndexer } from './services/indexer';
import { logger } from './services/logger';
import { startProofVerificationWorker } from './services/verification';

const app = express();

app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || env.CORS_ORIGINS.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(globalLimiter);

app.get('/health', async (_req, res) => {
  const health = await performHealthCheck();
  res.status(health.healthy ? 200 : 503).json(health);
});

app.use('/api', apiRouter);

app.get('/', (_req, res) => {
  res.json({ status: 'QuestForge AI backend online' });
});

app.listen(env.PORT, () => {
  logger.info('QuestForge AI backend listening', {
    port: env.PORT,
    environment: env.NODE_ENV
  });
  startQuestIndexer();
  startProofVerificationWorker();
});
