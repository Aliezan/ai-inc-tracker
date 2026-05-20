import 'dotenv/config';
import { resetTransactionLogs, setupTransactionSheets, TRANSACTION_SHEETS } from '../services/sheets';

function usage() {
  console.log(`
Usage:
  bun run sheets:reset -- --confirm [--include-test] [--include-balances]

Examples:
  bun run sheets:reset -- --confirm
  bun run sheets:reset -- --confirm --include-test
  bun run sheets:reset -- --confirm --include-test --include-balances

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
  if (err?.message === 'invalid_grant' || err?.response?.data?.error === 'invalid_grant') {
    console.error('Sheet reset failed: Google rejected GOOGLE_REFRESH_TOKEN.');
    console.error('Run `bun run google:get-token`, then replace GOOGLE_REFRESH_TOKEN in .env.');
    process.exit(1);
  }

  console.error('Sheet reset failed:', err);
  process.exit(1);
});
