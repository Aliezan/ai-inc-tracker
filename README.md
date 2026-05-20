# MoneyTrackerBOT

Personal finance tracker that ingests Gmail bank notifications, logs transactions to Google Sheets, and answers Telegram questions using the spreadsheet as context.

## Local Setup

```bash
bun install
cp .env.example .env
```

Fill `.env`, then initialize the spreadsheet:

```bash
bun run sheets:setup
```

## Production Runtime

Start only the HTTP service:

```bash
bun run start
```

Health endpoints:

```text
GET /healthz
GET /readyz
```

Runtime startup does not register external webhooks. Run those explicitly during deploy or maintenance.

## Webhook Setup

Register Telegram webhook:

```bash
bun run deploy:setup-telegram-webhook
```

Register Gmail watch:

```bash
bun run deploy:setup-gmail-watch
```

Gmail watches expire. Renew them at least daily with `deploy:setup-gmail-watch`.

If `WEBHOOK_SECRET` is set, configure Pub/Sub push endpoint with the token:

```text
https://your-service.example.com/webhook/gmail?token=WEBHOOK_SECRET
```

If `TELEGRAM_WEBHOOK_SECRET` is set, `deploy:setup-telegram-webhook` passes it to Telegram and incoming Telegram requests are verified.

## Google Sheets

`sheets:setup` creates and formats:

```text
MoneyTrackerBOT Trx Log
Test-Transactions
Account-Balances
System-State
```

Rows:

```text
Row 1: headers
Row 2: totals/state row
Row 3+: data
```

Reset log rows while keeping headers and totals:

```bash
bun run sheets:reset -- --confirm
```

## Testing

Dry-run fake email parsing:

```bash
bun run test:fake-email
```

Append fake transaction to test sheet:

```bash
bun run test:fake-email:append-test
```

Check Telegram webhook status:

```bash
bun run telegram:webhook-info
```

## Scheduled Reports

Send a spending/income report to Telegram:

```bash
bun run report:daily
bun run report:weekly
bun run report:monthly
```

Dry run without sending:

```bash
bun run report:send -- daily --dry-run
```

Example cron entries:

```cron
0 21 * * * cd /app && bun run report:daily
0 21 * * 0 cd /app && bun run report:weekly
0 21 1 * * cd /app && bun run report:monthly
```

List Gemini models available to your API key:

```bash
bun run gemini:list-models
```
