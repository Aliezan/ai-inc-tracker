import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { google } from 'googleapis';
import { getEmailForTransactionParsing, getGmailAuth, looksLikeTransactionEmail } from '../services/gmail.js';
import { isGeminiTransientError, parseEmailToTransaction } from '../services/gemini.js';
import { appendTransaction, getAppState, setAppState } from '../services/sheets.js';
import { notifyTransactionSaved, notifyIngestionComplete } from '../services/notifications.js';
import { config } from '../config.js';
import { logError } from '../services/logging.js';

export const gmailRouter = Router();

const GMAIL_HISTORY_STATE_KEY = 'gmail.lastHistoryId';
const GMAIL_PROCESSING_LEASE_KEY = 'gmail.processingLease';
const GMAIL_GEMINI_BACKOFF_UNTIL_KEY = 'gmail.geminiBackoffUntil';
const GMAIL_PROCESSED_MESSAGE_IDS_KEY = 'gmail.processedMessageIds';
const GMAIL_PROCESSING_LEASE_MS = 4 * 60 * 1000;
const GMAIL_GEMINI_MIN_BACKOFF_MS = 60 * 1000;
const GMAIL_GEMINI_MAX_BACKOFF_MS = 60 * 60 * 1000;

// ─── Deduplication and worker coordination ──────────────────────────────────
// Pub/Sub can deliver the same notification more than once.
// Keep a small local LRU for hot duplicates and persist the recent message IDs
// in Sheets so serverless invocations don't parse + append the same email twice.
const DEDUP_MAX_SIZE = 500;
const recentlyProcessedIds = new Set<string>();

type ProcessingLease = {
  owner: string;
  expiresAt: string;
};

type GmailProcessingResult = {
  cursorHistoryId: string | null;
  emailsProcessed: number;
  transactionsSaved: number;
  skipped: number;
};

function markProcessed(id: string) {
  recentlyProcessedIds.add(id);
  if (recentlyProcessedIds.size > DEDUP_MAX_SIZE) {
    // Drop the oldest entry (Sets iterate in insertion order)
    const first = recentlyProcessedIds.values().next().value!;
    recentlyProcessedIds.delete(first);
  }
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function parseProcessingLease(value: string | null): ProcessingLease | null {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as Partial<ProcessingLease>;
    if (!parsed.owner || !parsed.expiresAt) return null;
    return {
      owner: parsed.owner,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

function parseProcessedMessageIds(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string' && Boolean(item));
    }
  } catch {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }

  return [];
}

async function getProcessedMessageIds(): Promise<Set<string>> {
  return new Set(parseProcessedMessageIds(await getAppState(GMAIL_PROCESSED_MESSAGE_IDS_KEY)));
}

async function rememberProcessedMessageId(processedIds: Set<string>, id: string) {
  processedIds.delete(id);
  processedIds.add(id);

  while (processedIds.size > DEDUP_MAX_SIZE) {
    const first = processedIds.values().next().value;
    if (!first) break;
    processedIds.delete(first);
  }

  markProcessed(id);
  await setAppState(GMAIL_PROCESSED_MESSAGE_IDS_KEY, JSON.stringify([...processedIds]));
}

async function isGeminiBackoffActive() {
  const backoffUntil = parseTimestamp(await getAppState(GMAIL_GEMINI_BACKOFF_UNTIL_KEY));
  if (!backoffUntil) return false;

  if (backoffUntil <= Date.now()) {
    await setAppState(GMAIL_GEMINI_BACKOFF_UNTIL_KEY, '');
    return false;
  }

  console.warn(`Gmail ingestion deferred until ${new Date(backoffUntil).toISOString()} because Gemini is backing off.`);
  return true;
}

async function startGeminiBackoff(err: unknown) {
  const retryAfterMs = isGeminiTransientError(err)
    ? Math.min(Math.max(err.retryAfterMs, GMAIL_GEMINI_MIN_BACKOFF_MS), GMAIL_GEMINI_MAX_BACKOFF_MS)
    : 10 * 60 * 1000;
  const backoffUntil = new Date(Date.now() + retryAfterMs).toISOString();

  await setAppState(GMAIL_GEMINI_BACKOFF_UNTIL_KEY, backoffUntil);
  console.warn(`Gmail ingestion paused until ${backoffUntil} because Gemini returned a transient error.`);
}

async function acquireProcessingLease(historyId: string): Promise<string | null> {
  const existingLease = parseProcessingLease(await getAppState(GMAIL_PROCESSING_LEASE_KEY));
  const existingLeaseUntil = parseTimestamp(existingLease?.expiresAt ?? null);

  if (existingLeaseUntil && existingLeaseUntil > Date.now()) {
    console.log(`Gmail webhook skipped: another worker holds the processing lease until ${existingLease?.expiresAt}.`);
    return null;
  }

  const owner = `${randomUUID()}:${historyId}`;
  const lease: ProcessingLease = {
    owner,
    expiresAt: new Date(Date.now() + GMAIL_PROCESSING_LEASE_MS).toISOString(),
  };

  await setAppState(GMAIL_PROCESSING_LEASE_KEY, JSON.stringify(lease));

  const savedLease = parseProcessingLease(await getAppState(GMAIL_PROCESSING_LEASE_KEY));
  if (savedLease?.owner !== owner) {
    console.log('Gmail webhook skipped: processing lease was claimed by another worker.');
    return null;
  }

  return owner;
}

async function releaseProcessingLease(owner: string) {
  try {
    const existingLease = parseProcessingLease(await getAppState(GMAIL_PROCESSING_LEASE_KEY));
    if (existingLease?.owner === owner) {
      await setAppState(GMAIL_PROCESSING_LEASE_KEY, '');
    }
  } catch (err) {
    logError('Failed to release Gmail processing lease:', err);
  }
}

// ─── Webhook handler ─────────────────────────────────────────────────────────

gmailRouter.post('/webhook/gmail', async (req, res) => {
  if (config.webhookSecret && req.query.token !== config.webhookSecret) {
    return res.sendStatus(403);
  }

  const message = req.body?.message;
  if (!message?.data) return res.sendStatus(204);

  let decoded: { emailAddress?: string; historyId?: string };
  try {
    decoded = JSON.parse(Buffer.from(message.data, 'base64').toString());
  } catch (err) {
    logError('Invalid Gmail Pub/Sub payload:', err);
    return res.sendStatus(204);
  }

  const { historyId, emailAddress } = decoded;
  if (!historyId) return res.sendStatus(204);

  // Validate the notification is for the expected account
  if (emailAddress) {
    console.log(`Gmail webhook received for ${emailAddress}, historyId=${historyId}`);
  } else {
    console.log(`Gmail webhook received, historyId=${historyId}`);
  }

  let leaseOwner: string | null = null;

  try {
    if (await isGeminiBackoffActive()) {
      return res.sendStatus(204);
    }

    leaseOwner = await acquireProcessingLease(historyId);
    if (!leaseOwner) {
      return res.sendStatus(204);
    }

    if (await isGeminiBackoffActive()) {
      return res.sendStatus(204);
    }

    const lastHistoryId = await getAppState(GMAIL_HISTORY_STATE_KEY);
    if (!lastHistoryId) {
      // First-ever webhook: seed the cursor and stop. The next delivery will
      // have a valid delta to compare against.
      await setAppState(GMAIL_HISTORY_STATE_KEY, historyId);
      console.log('Gmail history cursor initialized:', historyId);
      return res.sendStatus(204);
    }

    const result = await processNewEmails(lastHistoryId);

    // Only advance the cursor AFTER processing succeeds
    await setAppState(GMAIL_HISTORY_STATE_KEY, result.cursorHistoryId ?? historyId);
    await setAppState(GMAIL_GEMINI_BACKOFF_UNTIL_KEY, '');
    return res.sendStatus(204);
  } catch (err) {
    if (isGeminiTransientError(err)) {
      await startGeminiBackoff(err);
      return res.sendStatus(204);
    }

    logError('Gmail webhook processing error:', err);

    // Return 500 so Pub/Sub will retry delivery.
    // This prevents silently dropping emails when downstream services
    // (Gemini, Sheets API, etc.) are temporarily unavailable.
    return res.sendStatus(500);
  } finally {
    if (leaseOwner) {
      await releaseProcessingLease(leaseOwner);
    }
  }
});

// ─── Process new emails from history ─────────────────────────────────────────

async function processNewEmails(startHistoryId: string): Promise<GmailProcessingResult> {
  const gmail = google.gmail({ version: 'v1', auth: getGmailAuth() });
  const processedMessageIds = await getProcessedMessageIds();
  const seenInRun = new Set<string>();

  let cursorHistoryId: string | null = null;
  let emailsProcessed = 0;
  let transactionsSaved = 0;
  let skipped = 0;
  let pageToken: string | undefined;

  do {
    let history;
    try {
      history = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
        labelId: 'INBOX',
        pageToken,
      });
    } catch (err: unknown) {
      const status = (err as { code?: number })?.code;

      if (status === 404) {
        // The startHistoryId is too old / expired.
        // Re-initialize the cursor from the current profile.
        console.warn(
          'Gmail history.list returned 404 (expired startHistoryId).',
          'Re-initializing cursor from current profile.',
        );
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const freshHistoryId = profile.data.historyId ?? null;
        if (freshHistoryId) {
          console.log('History cursor re-initialized to:', freshHistoryId);
        }
        // Emails between the old cursor and now are lost, but we can't recover
        // them via history.list anyway. The audit tool can catch them later.
        return { cursorHistoryId: freshHistoryId, emailsProcessed, transactionsSaved, skipped };
      }

      throw err; // re-throw other errors so the webhook returns 500
    }

    cursorHistoryId = history.data.historyId ?? cursorHistoryId;
    const messages = history.data.history?.flatMap(h => h.messagesAdded ?? []) ?? [];

    for (const { message } of messages) {
      if (!message?.id) continue;

      if (seenInRun.has(message.id)) continue;
      seenInRun.add(message.id);

      // Skip already-processed messages across Pub/Sub duplicate deliveries
      // and serverless invocations.
      if (recentlyProcessedIds.has(message.id) || processedMessageIds.has(message.id)) {
        console.log('Gmail message skipped: already processed (dedup)', message.id);
        skipped++;
        continue;
      }

      emailsProcessed++;

      try {
        const email = await getEmailForTransactionParsing(message.id);
        if (!email.body) {
          console.log('Gmail message skipped: no readable body', message.id);
          skipped++;
          await rememberProcessedMessageId(processedMessageIds, message.id);
          continue;
        }

        if (!looksLikeTransactionEmail(email)) {
          console.log('Gmail message skipped: not transaction-like', {
            id: message.id,
            subject: email.subject,
            from: email.from,
          });
          skipped++;
          await rememberProcessedMessageId(processedMessageIds, message.id);
          continue;
        }

        const tx = await parseEmailToTransaction(email.body, {
          from: email.from,
          subject: email.subject,
        });
        if (!tx) {
          console.log('Gmail message skipped: no valid transaction found', message.id);
          skipped++;
          await rememberProcessedMessageId(processedMessageIds, message.id);
          continue;
        }

        await appendTransaction(tx);
        console.log('Transaction saved:', tx);
        transactionsSaved++;
        await rememberProcessedMessageId(processedMessageIds, message.id);

        await notifyTransactionSaved(tx);
      } catch (err) {
        // If a single message fails, log it but let the outer error handler
        // decide whether to retry, back off, or return a permanent failure.
        logError(`Failed to process message ${message.id}:`, err);
        throw err;
      }
    }

    pageToken = history.data.nextPageToken ?? undefined;
  } while (pageToken);

  await notifyIngestionComplete({ emailsProcessed, transactionsSaved, skipped });
  return { cursorHistoryId, emailsProcessed, transactionsSaved, skipped };
}
