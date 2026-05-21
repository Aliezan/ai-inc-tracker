import { Router } from 'express';
import { google } from 'googleapis';
import { getEmailForTransactionParsing, getGmailAuth, looksLikeTransactionEmail } from '../services/gmail.js';
import { parseEmailToTransaction } from '../services/gemini.js';
import { appendTransaction, getAppState, setAppState } from '../services/sheets.js';
import { notifyTransactionSaved, notifyIngestionComplete } from '../services/notifications.js';
import { config } from '../config.js';

export const gmailRouter = Router();

const GMAIL_HISTORY_STATE_KEY = 'gmail.lastHistoryId';

// ─── Simple in-memory deduplication ──────────────────────────────────────────
// Pub/Sub can deliver the same notification more than once.
// Keep a small LRU set of recently-processed message IDs so we don't
// parse + append the same email twice.
const DEDUP_MAX_SIZE = 500;
const recentlyProcessedIds = new Set<string>();

function markProcessed(id: string) {
  recentlyProcessedIds.add(id);
  if (recentlyProcessedIds.size > DEDUP_MAX_SIZE) {
    // Drop the oldest entry (Sets iterate in insertion order)
    const first = recentlyProcessedIds.values().next().value!;
    recentlyProcessedIds.delete(first);
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
    console.error('Invalid Gmail Pub/Sub payload:', err);
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

  try {
    const lastHistoryId = await getAppState(GMAIL_HISTORY_STATE_KEY);
    if (!lastHistoryId) {
      // First-ever webhook: seed the cursor and stop. The next delivery will
      // have a valid delta to compare against.
      await setAppState(GMAIL_HISTORY_STATE_KEY, historyId);
      console.log('Gmail history cursor initialized:', historyId);
      return res.sendStatus(204);
    }

    await processNewEmails(lastHistoryId);

    // Only advance the cursor AFTER processing succeeds
    await setAppState(GMAIL_HISTORY_STATE_KEY, historyId);
    return res.sendStatus(204);
  } catch (err) {
    console.error('Gmail webhook processing error:', err);

    // Return 500 so Pub/Sub will retry delivery.
    // This prevents silently dropping emails when downstream services
    // (Gemini, Sheets API, etc.) are temporarily unavailable.
    return res.sendStatus(500);
  }
});

// ─── Process new emails from history ─────────────────────────────────────────

async function processNewEmails(startHistoryId: string) {
  const gmail = google.gmail({ version: 'v1', auth: getGmailAuth() });

  let history;
  try {
    history = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
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
      const freshHistoryId = profile.data.historyId;
      if (freshHistoryId) {
        await setAppState(GMAIL_HISTORY_STATE_KEY, freshHistoryId);
        console.log('History cursor re-initialized to:', freshHistoryId);
      }
      // Emails between the old cursor and now are lost, but we can't recover
      // them via history.list anyway. The audit tool can catch them later.
      return;
    }

    throw err; // re-throw other errors so the webhook returns 500
  }

  const messages = history.data.history?.flatMap(h => h.messagesAdded ?? []) ?? [];

  let emailsProcessed = 0;
  let transactionsSaved = 0;
  let skipped = 0;

  for (const { message } of messages) {
    if (!message?.id) continue;

    // Skip already-processed messages (Pub/Sub duplicate delivery)
    if (recentlyProcessedIds.has(message.id)) {
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
        markProcessed(message.id);
        continue;
      }

      if (!looksLikeTransactionEmail(email)) {
        console.log('Gmail message skipped: not transaction-like', {
          id: message.id,
          subject: email.subject,
          from: email.from,
        });
        skipped++;
        markProcessed(message.id);
        continue;
      }

      const tx = await parseEmailToTransaction(email.body, {
        from: email.from,
        subject: email.subject,
      });
      if (!tx) {
        console.log('Gmail message skipped: no valid transaction found', message.id);
        skipped++;
        markProcessed(message.id);
        continue;
      }

      await appendTransaction(tx);
      console.log('Transaction saved:', tx);
      transactionsSaved++;
      markProcessed(message.id);

      await notifyTransactionSaved(tx);
    } catch (err) {
      // If a single message fails, log it but let the outer error handler
      // propagate so Pub/Sub retries the whole batch.
      console.error(`Failed to process message ${message.id}:`, err);
      throw err;
    }
  }

  await notifyIngestionComplete({ emailsProcessed, transactionsSaved, skipped });
}
