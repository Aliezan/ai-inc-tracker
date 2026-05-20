import 'dotenv/config';
import { summarizeMoneyReport } from '../services/gemini';
import { getBalancesAsCsv, getTransactionsAsCsv } from '../services/sheets';
import { sendTelegramMessage } from '../services/telegram';

const REPORT_LIMITS = {
  daily: 80,
  weekly: 250,
  monthly: 700,
} as const;

type ReportPeriod = keyof typeof REPORT_LIMITS;

function usage() {
  console.log(`
Usage:
  bun run report:send -- [daily|weekly|monthly] [--limit N] [--dry-run]

Examples:
  bun run report:send -- daily
  bun run report:send -- weekly
  bun run report:send -- monthly --limit 1000
  bun run report:send -- daily --dry-run
  `.trim());
}

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(0);
  }

  const period = (args.find(arg => !arg.startsWith('--')) ?? 'daily') as ReportPeriod;
  if (!Object.keys(REPORT_LIMITS).includes(period)) {
    console.error(`Unknown report period: ${period}`);
    usage();
    process.exit(1);
  }

  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0
    ? Number(args[limitIndex + 1])
    : REPORT_LIMITS[period];

  if (!Number.isInteger(limit) || limit <= 0) {
    console.error('Invalid --limit value.');
    process.exit(1);
  }

  return {
    period,
    limit,
    dryRun: args.includes('--dry-run'),
  };
}

async function main() {
  const { period, limit, dryRun } = parseArgs();
  const reportName = `${period[0].toUpperCase()}${period.slice(1)} MoneyTrackerBOT report`;

  console.log(`Preparing ${reportName} using last ${limit} transaction rows...`);

  const [transactionsCsv, balancesCsv] = await Promise.all([
    getTransactionsAsCsv(limit),
    getBalancesAsCsv(),
  ]);

  const report = await summarizeMoneyReport(reportName, transactionsCsv, balancesCsv);

  if (dryRun) {
    console.log(report);
    return;
  }

  await sendTelegramMessage(report);
  console.log('Money report sent to Telegram.');
}

main().catch(err => {
  console.error('Money report failed:', err);
  process.exit(1);
});
