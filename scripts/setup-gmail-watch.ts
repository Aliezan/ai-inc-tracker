import 'dotenv/config';
import { setupGmailWatch } from '../services/gmail.js';
import { setAppState, setupTransactionSheets } from '../services/sheets.js';

async function main() {
  await setupTransactionSheets();
  const watch = await setupGmailWatch();

  if (watch.historyId) {
    await setAppState('gmail.lastHistoryId', watch.historyId);
    console.log(`Persisted Gmail history cursor: ${watch.historyId}`);
  }

  if (watch.expiration) {
    console.log(`Gmail watch expiration: ${new Date(Number(watch.expiration)).toISOString()}`);
  }
}

main().catch(err => {
  console.error('Gmail watch setup failed:', err);
  process.exit(1);
});
