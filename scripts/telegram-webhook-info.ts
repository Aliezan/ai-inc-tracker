import 'dotenv/config';
import { config } from '../config.js';
import { logError } from '../services/logging.js';

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getWebhookInfo`);
  const body = await res.json();

  console.log(JSON.stringify(body, null, 2));
}

main().catch(err => {
  logError('Failed to fetch Telegram webhook info:', err);
  process.exit(1);
});
