import { Router } from 'express';
import { google } from 'googleapis';
import { getEmailForTransactionParsing, getGmailAuth } from '../services/gmail';
import { parseEmailToTransaction } from '../services/gemini';
import { appendTransaction, getAppState, setAppState } from '../services/sheets';
import { config } from '../config';

export const gmailRouter = Router();

const GMAIL_HISTORY_STATE_KEY = 'gmail.lastHistoryId';

function looksLikeTransactionEmail(email: { subject: string; from: string; body: string | null }) {
  const text = [email.subject, email.from, email.body ?? ''].join('\n').toLowerCase();

  const hasMoney = /\b(idr|rp\.?|usd|\$)\s*[\d.,]+|\bamount\s*:/i.test(text);
  const hasTransactionWord = [
    'transaction',
    'debit',
    'debited',
    'credit',
    'credited',
    'transfer',
    'payment',
    'purchase',
    'merchant',
    'available balance',
    'current balance',
  ].some(keyword => text.includes(keyword));

  return hasMoney && hasTransactionWord;
}

gmailRouter.post('/webhook/gmail', async (req, res) => {
  if (config.webhookSecret && req.query.token !== config.webhookSecret) {
    return res.sendStatus(403);
  }

  const message = req.body?.message;
  if (!message?.data) return res.sendStatus(204);

  let decoded: { historyId?: string };
  try {
    decoded = JSON.parse(Buffer.from(message.data, 'base64').toString());
  } catch (err) {
    console.error('Invalid Gmail Pub/Sub payload:', err);
    return res.sendStatus(204);
  }

  const { historyId } = decoded;
  if (!historyId) return res.sendStatus(204);

  res.sendStatus(204);

  try {
    const lastHistoryId = await getAppState(GMAIL_HISTORY_STATE_KEY);
    if (!lastHistoryId) {
      await setAppState(GMAIL_HISTORY_STATE_KEY, historyId);
      console.log('Gmail history cursor initialized:', historyId);
      return;
    }

    await processNewEmails(lastHistoryId);
    await setAppState(GMAIL_HISTORY_STATE_KEY, historyId);
  } catch (err) {
    console.error('Gmail webhook processing error:', err);
  }
});

async function processNewEmails(startHistoryId: string) {
  const gmail = google.gmail({ version: 'v1', auth: getGmailAuth() });

  const history = await gmail.users.history.list({
    userId: 'me',
    startHistoryId,
    historyTypes: ['messageAdded'],
  });

  const messages = history.data.history?.flatMap(h => h.messagesAdded ?? []) ?? [];

  for (const { message } of messages) {
    if (!message?.id) continue;

    const email = await getEmailForTransactionParsing(message.id);
    if (!email.body) {
      console.log('Gmail message skipped: no readable body', message.id);
      continue;
    }

    if (!looksLikeTransactionEmail(email)) {
      console.log('Gmail message skipped: not transaction-like', {
        id: message.id,
        subject: email.subject,
        from: email.from,
      });
      continue;
    }

    const tx = await parseEmailToTransaction(email.body, {
      from: email.from,
      subject: email.subject,
    });
    if (!tx) {
      console.log('Gmail message skipped: no valid transaction found', message.id);
      continue;
    }

    await appendTransaction(tx);
    console.log('Transaction saved:', tx);
  }
}
