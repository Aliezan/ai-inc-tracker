import { Router } from 'express';
import { config } from '../config.js';
import { answerQuestion, categorizeTransactions, parseEmailToTransaction } from '../services/gemini.js';
import {
  BANK_ACCOUNTS,
  appendTransaction,
  batchUpdateTransactionCategories,
  getBalancesAsCsv,
  getRecentTransactions,
  getTransactionsAsCsv,
  getUncategorizedTransactions,
  updateAccountBalance,
} from '../services/sheets.js';
import { isNotificationsEnabled, toggleNotifications, notifyTransactionSaved } from '../services/notifications.js';
import { runDiagnostics, formatDiagnosticsReport } from '../services/diagnostics.js';
import { getRecentInboxEmails } from '../services/gmail.js';
import { logError } from '../services/logging.js';
import type { Transaction } from '../services/gemini.js';

export const telegramRouter = Router();

// In-memory store for missed transactions pending user confirmation
let pendingMissedTransactions: Transaction[] | null = null;

type ReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

const QUICK_ACTIONS: Record<string, string> = {
  today_spend: 'How much did I spend today? Break it down by category, account, and merchant.',
  month_summary: 'Summarize my income and expenses this month by account and category.',
  biggest_expenses: 'What are my biggest expenses recently by category?',
  recent_transactions: 'Show my 10 most recent transactions.',
  balance_check: 'What are my latest account balances across Jago, BCA, CIMB Niaga (OCTO), Bank Raya, and Permata ME?',
};

async function getMainMenu(): Promise<ReplyMarkup> {
  const notificationsOn = await isNotificationsEnabled();
  const notifLabel = notificationsOn ? '🔔 Notifications: ON' : '🔕 Notifications: OFF';

  return {
    inline_keyboard: [
      [
        { text: 'Today spend', callback_data: 'today_spend' },
        { text: 'Month summary', callback_data: 'month_summary' },
      ],
      [
        { text: 'Biggest expenses', callback_data: 'biggest_expenses' },
        { text: 'Recent transactions', callback_data: 'recent_transactions' },
      ],
      [
        { text: 'Latest balance', callback_data: 'balance_check' },
      ],
      [
        { text: '🏷 Categorize', callback_data: 'categorize' },
      ],
      [
        { text: notifLabel, callback_data: 'toggle_notifications' },
      ],
      [
        { text: '🔧 Diagnostics', callback_data: 'diagnostics' },
        { text: '📩 Check emails', callback_data: 'check_emails' },
      ],
    ],
  };
}

function getHelpText() {
  return [
    'Choose a quick action or ask a finance question directly.',
    '',
    'Balance commands:',
    '- /balances',
    '- /balance Jago 1250000',
    '- /balance BCA 2500000',
    '- /balance CIMB 3000000',
    '- /balance Raya 900000',
    '- /balance Permata 5000000',
    '',
    'Categorization:',
    '- /categorize - Auto-categorize uncategorized transactions',
    '',
    'Notifications:',
    '- /notifications - Toggle transaction & ingestion notifications',
    '',
    'System:',
    '- /diagnostics - Check all system connections',
    '- /checkemails - Find transaction emails that may have been missed',
    '',
    `Supported accounts: ${BANK_ACCOUNTS.join(', ')}`,
  ].join('\n');
}

function parseBalanceCommand(text: string) {
  const match = /^\/balance\s+(.+?)\s+([\d.,_]+)(?:\s+(.+))?$/i.exec(text.trim());
  if (!match) return null;

  const sourceOfFund = match[1];
  const amount = Number(match[2].replace(/[.,_]/g, ''));
  const note = match[3] ?? 'Updated from Telegram bot';

  if (!Number.isFinite(amount) || amount < 0) return null;

  return { sourceOfFund, amount, note };
}

telegramRouter.post('/webhook/telegram', async (req, res) => {
  if (
    config.telegramWebhookSecret &&
    req.header('x-telegram-bot-api-secret-token') !== config.telegramWebhookSecret
  ) {
    return res.sendStatus(403);
  }

  const update = req.body;
  const message = update?.message;
  const callbackQuery = update?.callback_query;

  const chatId = message?.chat?.id ?? callbackQuery?.message?.chat?.id;
  if (String(chatId) !== config.telegramChatId) return res.sendStatus(200);

  if (callbackQuery) {
    await answerCallbackQuery(callbackQuery.id);
  }

  const text = message?.text;
  if (text === '/start' || text === '/help') {
    await sendTelegramMessage(getHelpText(), await getMainMenu());
    return res.sendStatus(200);
  }

  if (text === '/balances') {
    const balancesCsv = await getBalancesAsCsv();
    await sendTelegramMessage(`Latest balances:\n\n${balancesCsv}`, await getMainMenu());
    return res.sendStatus(200);
  }

  if (text?.startsWith('/balance ')) {
    const parsed = parseBalanceCommand(text);
    if (!parsed) {
      await sendTelegramMessage('Use: /balance Jago 1250000');
      return res.sendStatus(200);
    }

    await updateAccountBalance(parsed.sourceOfFund, parsed.amount, parsed.note);
    await sendTelegramMessage(`Updated ${parsed.sourceOfFund} balance to ${parsed.amount}.`, await getMainMenu());
    return res.sendStatus(200);
  }

  if (text === '/notifications' || callbackQuery?.data === 'toggle_notifications') {
    const newState = await toggleNotifications();
    const statusEmoji = newState ? '🔔' : '🔕';
    const statusText = newState ? 'ON' : 'OFF';
    await sendTelegramMessage(
      `${statusEmoji} Transaction & ingestion notifications are now *${statusText}*`,
      await getMainMenu(),
    );
    return res.sendStatus(200);
  }

  if (text === '/diagnostics' || callbackQuery?.data === 'diagnostics') {
    await sendChatAction('typing');
    await sendTelegramMessage('🔧 Running system diagnostics...');

    const results = await runDiagnostics();
    const report = formatDiagnosticsReport(results);
    await sendTelegramMessage(report, await getMainMenu());
    return res.sendStatus(200);
  }

  if (text === '/checkemails' || callbackQuery?.data === 'check_emails') {
    await sendChatAction('typing');
    await sendTelegramMessage('📩 Scanning recent inbox emails...');

    try {
      const emails = await getRecentInboxEmails(15);
      const transactionEmails = emails.filter(e => e.isTransactionLike);

      if (transactionEmails.length === 0) {
        await sendTelegramMessage('No transaction-like emails found in recent inbox.', await getMainMenu());
        return res.sendStatus(200);
      }

      // Cross-reference with existing transactions in the sheet
      const stored = await getRecentTransactions(100);

      // Build a set of fingerprints from stored transactions for matching
      const storedFingerprints = new Set(
        stored.map(tx => `${tx.amount}|${tx.dateTime}`),
      );

      // Parse each transaction email and check if it's already in the sheet
      const missed: Array<{ email: typeof transactionEmails[0]; parsed: Transaction }> = [];

      for (const email of transactionEmails) {
        if (!email.body) continue;
        const parsed = await parseEmailToTransaction(email.body, {
          from: email.from,
          subject: email.subject,
        });
        if (!parsed) continue;

        const fingerprint = `${parsed.amount}|${parsed.dateTime}`;
        if (!storedFingerprints.has(fingerprint)) {
          missed.push({ email, parsed });
        }
      }

      if (missed.length === 0) {
        await sendTelegramMessage(
          `✅ Checked ${transactionEmails.length} transaction emails — all are already in the sheet.`,
          await getMainMenu(),
        );
        return res.sendStatus(200);
      }

      // Show missed transactions and offer to ingest them
      const lines = [
        `⚠️ Found ${missed.length} potentially missed transaction(s):`,
        '',
      ];

      for (const { parsed } of missed) {
        lines.push(
          `• ${parsed.sourceOfFund} | ${parsed.transactionType} | Rp ${formatCurrency(parsed.amount)} | ${parsed.dateTime}`,
        );
      }

      lines.push('', 'Tap "Ingest missed" to add them to the sheet.');

      // Store missed transactions temporarily for the ingest callback
      pendingMissedTransactions = missed.map(m => m.parsed);

      await sendTelegramMessage(lines.join('\n'), {
        inline_keyboard: [
          [
            { text: '✅ Ingest missed', callback_data: 'ingest_missed' },
            { text: '❌ Skip', callback_data: 'skip_missed' },
          ],
        ],
      });
    } catch (err) {
      logError('Check emails error:', err);
      await sendTelegramMessage('Failed to check emails. See logs.', await getMainMenu());
    }
    return res.sendStatus(200);
  }

  if (callbackQuery?.data === 'ingest_missed') {
    if (!pendingMissedTransactions || pendingMissedTransactions.length === 0) {
      await sendTelegramMessage('No pending missed transactions to ingest.', await getMainMenu());
      return res.sendStatus(200);
    }

    await sendChatAction('typing');
    let ingested = 0;
    for (const tx of pendingMissedTransactions) {
      await appendTransaction(tx);
      await notifyTransactionSaved(tx);
      ingested++;
    }

    pendingMissedTransactions = null;
    await sendTelegramMessage(`✅ Ingested ${ingested} missed transaction(s) into the sheet.`, await getMainMenu());
    return res.sendStatus(200);
  }

  if (callbackQuery?.data === 'skip_missed') {
    pendingMissedTransactions = null;
    await sendTelegramMessage('Skipped. No transactions were added.', await getMainMenu());
    return res.sendStatus(200);
  }

  if (text === '/categorize' || callbackQuery?.data === 'categorize') {
    await sendChatAction('typing');
    await sendTelegramMessage('🔍 Reading uncategorized transactions...');

    const uncategorized = await getUncategorizedTransactions();
    if (uncategorized.length === 0) {
      await sendTelegramMessage('✅ All transactions are already categorized!', await getMainMenu());
      return res.sendStatus(200);
    }

    await sendTelegramMessage(`Found ${uncategorized.length} uncategorized transactions. Asking Gemini to categorize...`);
    await sendChatAction('typing');

    const updates = await categorizeTransactions(uncategorized);
    await batchUpdateTransactionCategories(updates);

    await sendTelegramMessage(`✅ Categorized ${updates.length} transactions!`, await getMainMenu());
    return res.sendStatus(200);
  }

  const question = callbackQuery
    ? QUICK_ACTIONS[callbackQuery.data as keyof typeof QUICK_ACTIONS]
    : text;

  if (!question) return res.sendStatus(200);

  try {
    await sendChatAction('typing');
    await sendTelegramMessage('Reading the Transactions sheet...');
    const csv = await getTransactionsAsCsv(150);
    const balancesCsv = await getBalancesAsCsv();

    await sendChatAction('typing');
    await sendTelegramMessage('Asking Gemini with the latest transaction and balance context...');
    const answer = await answerQuestion(question, csv, balancesCsv);
    await sendTelegramMessage(answer, await getMainMenu());
  } catch (err) {
    logError('Telegram handler error:', err);
    await sendTelegramMessage('Something went wrong. Check the logs.');
  }

  res.sendStatus(200);
});

async function answerCallbackQuery(callbackQueryId: string) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });

  if (!res.ok) {
    console.error('Telegram answerCallbackQuery failed:', await res.text());
  }
}

async function sendChatAction(action: 'typing') {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.telegramChatId, action }),
  });

  if (!res.ok) {
    console.error('Telegram sendChatAction failed:', await res.text());
  }
}

async function sendTelegramMessage(text: string, replyMarkup?: ReplyMarkup) {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      reply_markup: replyMarkup,
    }),
  });

  if (!res.ok) {
    console.error('Telegram sendMessage failed:', await res.text());
  }
}

// Run once to register webhook with Telegram
export async function registerTelegramWebhook(baseUrl: string) {
  if (!baseUrl) {
    throw new Error('PUBLIC_BASE_URL is required to register the Telegram webhook.');
  }

  const webhookUrl = new URL('/webhook/telegram', baseUrl);
  const requestBody: Record<string, string> = { url: webhookUrl.toString() };
  if (config.telegramWebhookSecret) {
    requestBody.secret_token = config.telegramWebhookSecret;
  }

  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    console.error('Telegram webhook registration failed:', body);
    return;
  }

  console.log('Telegram webhook registered:', body);
}
