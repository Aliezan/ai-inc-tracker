import express from 'express';
import { config } from './config.js';
import { gmailRouter } from './routes/gmail.js';
import { telegramRouter } from './routes/telegram.js';

const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'money-tracker-bot',
    env: config.nodeEnv,
  });
});

app.get('/readyz', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(gmailRouter);
app.use(telegramRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled request error:', err);
  res.sendStatus(500);
});

const server = app.listen(config.port, () => {
  console.log(`Server running on port ${config.port}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received. Shutting down...`);
  server.close(err => {
    if (err) {
      console.error('Shutdown failed:', err);
      process.exit(1);
    }

    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', err => {
  console.error('Unhandled promise rejection:', err);
});

process.on('uncaughtException', err => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});
