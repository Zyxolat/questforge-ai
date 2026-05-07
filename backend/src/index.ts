import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { apiRouter } from './routes/api';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 120 });
app.use(limiter);

app.use('/api', apiRouter);

app.get('/', (_req, res) => {
  res.json({ status: 'QuestForge AI backend online' });
});

app.listen(port, () => {
  console.log(`QuestForge AI backend listening on port ${port}`);
});
