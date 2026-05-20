import 'dotenv/config';
import { config } from '../config';

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getWebhookInfo`);
  const body = await res.json();

  console.log(JSON.stringify(body, null, 2));
}

main().catch(err => {
  console.error('Failed to fetch Telegram webhook info:', err);
  process.exit(1);
});
