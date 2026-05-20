import 'dotenv/config';
import { SPREADSHEET_TITLE, setupTransactionSheets, TRANSACTION_SHEETS } from '../services/sheets.js';

async function main() {
  await setupTransactionSheets();

  console.log('Google Sheets setup complete.');
  console.log(`Spreadsheet title: ${SPREADSHEET_TITLE}`);
  console.log(`Real transactions tab: ${TRANSACTION_SHEETS.real}`);
  console.log(`Test transactions tab: ${TRANSACTION_SHEETS.test}`);
  console.log(`Balances tab: ${TRANSACTION_SHEETS.balances}`);
}

main().catch(err => {
  if (err?.message === 'invalid_grant' || err?.response?.data?.error === 'invalid_grant') {
    console.error('Google Sheets setup failed: Google rejected GOOGLE_REFRESH_TOKEN.');
    console.error('Run `npm run build && npm run google:get-token`, then replace GOOGLE_REFRESH_TOKEN in .env.');
    console.error('Make sure the token is generated with the same GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET currently in .env.');
    process.exit(1);
  }

  console.error('Google Sheets setup failed:', err);
  process.exit(1);
});
