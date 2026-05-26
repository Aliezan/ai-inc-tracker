import 'dotenv/config';
import { google } from 'googleapis';
import { extractEmailBody } from '../services/gmail.js';
import { logError } from '../services/logging.js';

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN!;

if (!REFRESH_TOKEN) {
  console.error('❌ GOOGLE_REFRESH_TOKEN not set. Run scripts/get-token.ts first.');
  process.exit(1);
}

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
auth.setCredentials({ refresh_token: REFRESH_TOKEN });

const gmail = google.gmail({ version: 'v1', auth });

function redactEncodedBodyData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactEncodedBodyData);
  if (!value || typeof value !== 'object') return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = key === 'data' && typeof child === 'string'
      ? `[base64url body omitted, ${child.length} chars]`
      : redactEncodedBodyData(child);
  }

  return redacted;
}

async function main() {
  // ─── 1. List recent messages ───────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════');
  console.log('📬  STEP 1: Listing recent messages (max 5)');
  console.log('═══════════════════════════════════════════════════════\n');

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 5,
    labelIds: ['INBOX'],
  });

  console.log('Raw list response:\n');
  console.log(JSON.stringify(listRes.data, null, 2));

  const messages = listRes.data.messages ?? [];
  if (messages.length === 0) {
    console.log('\nNo messages found. Exiting.');
    return;
  }

  // ─── 2. Get full message details for the first email ───────────────
  const firstMsgId = messages[0].id!;

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`📧  STEP 2: Full message details (id: ${firstMsgId})`);
  console.log('═══════════════════════════════════════════════════════\n');

  const fullMsg = await gmail.users.messages.get({
    userId: 'me',
    id: firstMsgId,
    format: 'full',
  });

  console.log('Raw full message response:\n');
  console.log(JSON.stringify(redactEncodedBodyData(fullMsg.data), null, 2));

  // ─── 3. Extract useful fields ──────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('🔍  STEP 3: Extracted fields');
  console.log('═══════════════════════════════════════════════════════\n');

  const headers = fullMsg.data.payload?.headers ?? [];
  const getHeader = (name: string) =>
    headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '(not found)';

  console.log('Subject:', getHeader('Subject'));
  console.log('From:', getHeader('From'));
  console.log('To:', getHeader('To'));
  console.log('Date:', getHeader('Date'));
  console.log('Labels:', fullMsg.data.labelIds?.join(', '));
  console.log('Snippet:', fullMsg.data.snippet);

  // ─── 4. Decode body ───────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('📄  STEP 4: Decoded body');
  console.log('═══════════════════════════════════════════════════════\n');

  const decodedBody = extractEmailBody(fullMsg.data.payload);

  if (decodedBody) {
    console.log('Decoded body:\n');
    console.log(decodedBody.substring(0, 2000)); // First 2000 chars
    if (decodedBody.length > 2000) console.log('\n... (truncated)');
  } else {
    console.log('No readable text/plain or text/html body found.');
  }

  // ─── 5. Payload structure overview ────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('🗂️  STEP 5: Payload structure overview');
  console.log('═══════════════════════════════════════════════════════\n');

  function printStructure(payload: any, indent = 0) {
    const prefix = '  '.repeat(indent);
    console.log(`${prefix}mimeType: ${payload.mimeType}`);
    console.log(`${prefix}body.size: ${payload.body?.size ?? 0} bytes`);
    console.log(`${prefix}has body.data: ${!!payload.body?.data}`);
    if (payload.parts) {
      console.log(`${prefix}parts (${payload.parts.length}):`);
      for (const part of payload.parts) {
        printStructure(part, indent + 1);
      }
    }
  }

  if (fullMsg.data.payload) {
    printStructure(fullMsg.data.payload);
  }
}

main().catch(err => {
  logError('❌ Error:', err);
});
