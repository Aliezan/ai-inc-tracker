import 'dotenv/config';
import { resetTransactionLogs, setupTransactionSheets, TRANSACTION_SHEETS } from '../services/sheets.js';
import { isInvalidGrantError, logError } from '../services/logging.js';

function usage() {
  console.log(`
Usage:
  npm run sheets:reset -- --confirm [--include-test] [--include-balances]

Examples:
  npm run sheets:reset -- --confirm
  npm run sheets:reset -- --confirm --include-test
  npm run sheets:reset -- --confirm --include-test --include-balances

By default this clears rows 3+ from ${TRANSACTION_SHEETS.real} only.
Headers and total rows are kept.
  `.trim());
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  if (!args.includes('--confirm')) {
    console.error('Refusing to reset sheets without --confirm.');
    usage();
    process.exit(1);
  }

  const includeTest = args.includes('--include-test');
  const includeBalances = args.includes('--include-balances');

  await setupTransactionSheets();
  await resetTransactionLogs({ includeTest, includeBalances });

  console.log(`Cleared log rows from ${TRANSACTION_SHEETS.real}.`);
  if (includeTest) console.log(`Cleared log rows from ${TRANSACTION_SHEETS.test}.`);
  if (includeBalances) console.log(`Cleared balance rows from ${TRANSACTION_SHEETS.balances} and re-seeded bank names.`);
}

main().catch(err => {
  if (isInvalidGrantError(err)) {
    console.error('Sheet reset failed: Google rejected GOOGLE_REFRESH_TOKEN.');
    console.error('Run `npm run build && npm run google:get-token`, then replace GOOGLE_REFRESH_TOKEN in .env.');
    process.exit(1);
  }

  logError('Sheet reset failed:', err);
  process.exit(1);
});
