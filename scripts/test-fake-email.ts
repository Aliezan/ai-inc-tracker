import 'dotenv/config';
import { parseEmailToTransaction } from '../services/gemini';
import { appendTestTransaction, TRANSACTION_SHEETS } from '../services/sheets';

const samples = {
  debit: {
    from: 'notification@jago.com',
    subject: 'Transaction Notification',
    body: `
Transaction Notification

Dear customer,

Your account was debited on 2026-05-18 14:32:00.
Amount: IDR 125,000
Merchant: Sandbox Coffee
Description: Card purchase at Sandbox Coffee Jakarta
Available balance: IDR 4,875,000
    `.trim(),
  },

  credit: {
    from: 'octo-notification@cimbniaga.co.id',
    subject: 'Incoming Transfer Notification',
    body: `
Incoming Transfer Notification

You received money on 2026-05-18 09:15:00.
Amount: IDR 2,500,000
Sender: Test Payroll Inc
Description: May salary test payment
Current balance: IDR 7,250,000
    `.trim(),
  },
};

function usage() {
  console.log(`
Usage:
  bun run scripts/test-fake-email.ts [debit|credit] [--append]

Examples:
  bun run scripts/test-fake-email.ts
  bun run scripts/test-fake-email.ts credit
  bun run scripts/test-fake-email.ts debit --append

Default mode parses a fake email and prints the transaction only.
Use --append to also write the parsed transaction to ${TRANSACTION_SHEETS.test}.
  `.trim());
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    usage();
    return;
  }

  const sampleName = args.find(arg => !arg.startsWith('--')) ?? 'debit';
  const sample = samples[sampleName as keyof typeof samples];
  const shouldAppend = args.includes('--append');

  if (!sample) {
    console.error(`Unknown sample: ${sampleName}`);
    usage();
    process.exit(1);
  }

  const emailBody = sample.body;
  console.log('Fake email body:');
  console.log(emailBody);
  console.log('\nParsing...');

  const tx = await parseEmailToTransaction(emailBody, {
    from: sample.from,
    subject: sample.subject,
  });
  if (!tx) {
    console.error('No transaction parsed.');
    process.exit(1);
  }

  console.log('\nParsed transaction:');
  console.log(JSON.stringify(tx, null, 2));

  if (!shouldAppend) {
    console.log(`\nDry run only. Add --append to write this transaction to ${TRANSACTION_SHEETS.test}.`);
    return;
  }

  await appendTestTransaction(tx);
  console.log(`\nAppended transaction to ${TRANSACTION_SHEETS.test}.`);
}

main().catch(err => {
  if (err?.message === 'invalid_grant' || err?.response?.data?.error === 'invalid_grant') {
    console.error('Fake email test failed: Google rejected GOOGLE_REFRESH_TOKEN.');
    console.error('Run `bun run google:get-token`, then replace GOOGLE_REFRESH_TOKEN in .env.');
    console.error('Make sure the token is generated with the same GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET currently in .env.');
    process.exit(1);
  }

  console.error('Fake email test failed:', err);
  process.exit(1);
});
