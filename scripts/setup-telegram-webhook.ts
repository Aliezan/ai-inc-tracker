import 'dotenv/config';
import { config } from '../config.js';
import { registerTelegramWebhook } from '../routes/telegram.js';
import { logError } from '../services/logging.js';

async function main() {
  if (!config.publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is required to register the Telegram webhook.');
  }

  await registerTelegramWebhook(config.publicBaseUrl);
}

main().catch(err => {
  logError('Telegram webhook setup failed:', err);
  process.exit(1);
});
