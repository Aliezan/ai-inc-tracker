import { google } from 'googleapis';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config.js';
import { getGmailAuth } from './gmail.js';
import { getAppState, TRANSACTION_SHEETS } from './sheets.js';

export interface DiagnosticResult {
  service: string;
  status: 'ok' | 'error';
  detail: string;
  latencyMs: number;
}

async function timedCheck(
  service: string,
  fn: () => Promise<string>,
): Promise<DiagnosticResult> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { service, status: 'ok', detail, latencyMs: Date.now() - start };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { service, status: 'error', detail: message, latencyMs: Date.now() - start };
  }
}

// ─── Individual checks ──────────────────────────────────────────────────────

async function checkGmail(): Promise<string> {
  const gmail = google.gmail({ version: 'v1', auth: getGmailAuth() });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return `Email: ${profile.data.emailAddress}, History ID: ${profile.data.historyId}`;
}

async function checkSheets(): Promise<string> {
  const sheets = google.sheets({ version: 'v4', auth: getGmailAuth() });
  const res = await sheets.spreadsheets.get({
    spreadsheetId: config.sheetId,
    fields: 'properties.title,sheets.properties.title',
  });

  const title = res.data.properties?.title ?? 'Unknown';
  const sheetNames = res.data.sheets?.map(s => s.properties?.title).filter(Boolean) ?? [];
  return `Spreadsheet: "${title}", Sheets: ${sheetNames.join(', ')}`;
}

async function checkTelegram(): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getMe`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as { result?: { username?: string; first_name?: string } };
  return `Bot: @${data.result?.username ?? 'unknown'} (${data.result?.first_name ?? ''})`;
}

async function checkTelegramWebhook(): Promise<string> {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/getWebhookInfo`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as {
    result?: {
      url?: string;
      has_custom_certificate?: boolean;
      pending_update_count?: number;
      last_error_message?: string;
      last_error_date?: number;
    };
  };
  const info = data.result;
  const lines = [`URL: ${info?.url || '(not set)'}`];
  lines.push(`Pending updates: ${info?.pending_update_count ?? 0}`);
  if (info?.last_error_message) {
    const errorDate = info.last_error_date
      ? new Date(info.last_error_date * 1000).toISOString()
      : 'unknown';
    lines.push(`Last error: ${info.last_error_message} (${errorDate})`);
  }
  return lines.join(', ');
}

async function checkPubSub(): Promise<string> {
  // The OAuth2 token is scoped for Gmail/Sheets — not Pub/Sub directly.
  // Instead, verify config and use the Gmail API to confirm push delivery is active.
  const topicName = config.pubsub.topicName;
  const projectId = config.pubsub.projectId;
  if (!topicName || !projectId) {
    throw new Error('PUBSUB_TOPIC or GOOGLE_PROJECT_ID not configured');
  }

  // Gmail's watch endpoint returns the current push subscription status.
  // If watch is not set up, historyId will be absent.
  const gmail = google.gmail({ version: 'v1', auth: getGmailAuth() });
  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName,
      labelFilterAction: 'include',
      labelIds: ['INBOX'],
    },
  });

  const expiry = res.data.expiration
    ? new Date(Number(res.data.expiration)).toISOString()
    : 'unknown';

  return `Topic: ${topicName}, Watch expiry: ${expiry}`;
}

async function checkGmailWatch(): Promise<string> {
  const historyId = await getAppState('gmail.lastHistoryId');
  if (!historyId) {
    return 'Gmail watch cursor not initialized (no history ID stored)';
  }
  return `Last History ID: ${historyId}`;
}

async function checkGemini(): Promise<string> {
  const ai = new GoogleGenerativeAI(config.geminiApiKey);
  const model = ai.getGenerativeModel({ model: config.geminiModel });
  const result = await model.generateContent('Reply with only the word "ok".');
  const text = result.response.text().trim();
  return `Model: ${config.geminiModel}, Response: "${text.slice(0, 50)}"`;
}

// ─── Run all diagnostics ────────────────────────────────────────────────────

export async function runDiagnostics(): Promise<DiagnosticResult[]> {
  const results = await Promise.all([
    timedCheck('Gmail API', checkGmail),
    timedCheck('Google Sheets', checkSheets),
    timedCheck('Telegram Bot', checkTelegram),
    timedCheck('Telegram Webhook', checkTelegramWebhook),
    timedCheck('Pub/Sub Topic', checkPubSub),
    timedCheck('Gmail Watch Cursor', checkGmailWatch),
    timedCheck('Gemini AI', checkGemini),
  ]);

  return results;
}

export function formatDiagnosticsReport(results: DiagnosticResult[]): string {
  const allOk = results.every(r => r.status === 'ok');
  const header = allOk
    ? '✅ All systems operational'
    : '⚠️ Some systems have issues';

  const lines = results.map(r => {
    const icon = r.status === 'ok' ? '✅' : '❌';
    const latency = `${r.latencyMs}ms`;
    return `${icon} ${r.service} (${latency})\n   ${r.detail}`;
  });

  return [header, '', ...lines].join('\n');
}
