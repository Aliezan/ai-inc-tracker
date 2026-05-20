import 'dotenv/config';
import { config } from '../config';
import { registerTelegramWebhook } from '../routes/telegram';

async function main() {
  if (!config.publicBaseUrl) {
    throw new Error('PUBLIC_BASE_URL is required to register the Telegram webhook.');
  }

  await registerTelegramWebhook(config.publicBaseUrl);
}

main().catch(err => {
  console.error('Telegram webhook setup failed:', err);
  process.exit(1);
});
