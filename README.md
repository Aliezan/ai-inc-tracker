# MoneyTrackerBOT

Personal finance tracker that ingests Gmail bank notifications, logs transactions to Google Sheets, and answers Telegram questions using the spreadsheet as context.

## Local Setup

```bash
npm install
cp .env.example .env
```

Fill `.env`, then initialize the spreadsheet:

```bash
npm run build
npm run sheets:setup
```

## Production Runtime

Start only the HTTP service:

```bash
npm run start
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
npm run deploy:setup-telegram-webhook
```

Register Gmail watch:

```bash
npm run deploy:setup-gmail-watch
```

Gmail watches expire. Renew them at least daily with `deploy:setup-gmail-watch`.

If `WEBHOOK_SECRET` is set, configure Pub/Sub push endpoint with the token:

```text
https://your-service.example.com/webhook/gmail?token=WEBHOOK_SECRET
```

If `TELEGRAM_WEBHOOK_SECRET` is set, `deploy:setup-telegram-webhook` passes it to Telegram and incoming Telegram requests are verified.

### Google OAuth `invalid_grant`

If Gmail, Sheets, Telegram diagnostics, or webhook handling fails with:

```text
invalid_grant: Token has been expired or revoked.
```

the request is reaching the app, but Google rejected `GOOGLE_REFRESH_TOKEN`.
Rotate it with:

```bash
npm run build
npm run google:get-token
```

Then update `GOOGLE_REFRESH_TOKEN` in local and production env, redeploy, and run:

```bash
npm run deploy:setup-gmail-watch
```

If the old refresh token appeared in logs, revoke it in Google Account / Google Cloud Console before generating the replacement.

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
npm run sheets:reset -- --confirm
```

## Testing

Dry-run fake email parsing:

```bash
npm run test:fake-email
```

Append fake transaction to test sheet:

```bash
npm run test:fake-email:append-test
```

Check Telegram webhook status:

```bash
npm run telegram:webhook-info
```

## Scheduled Reports

Send a spending/income report to Telegram:

```bash
npm run report:daily
npm run report:weekly
npm run report:monthly
```

Dry run without sending:

```bash
npm run report:send -- daily --dry-run
```

Example cron entries:

```cron
0 21 * * * cd /app && npm run report:daily
0 21 * * 0 cd /app && npm run report:weekly
0 21 1 * * cd /app && npm run report:monthly
```

List Gemini models available to your API key:

```bash
npm run gemini:list-models
```
