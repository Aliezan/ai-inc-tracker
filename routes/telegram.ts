import { Router } from 'express';
import { config } from '../config.js';
import { answerQuestion, categorizeTransactions } from '../services/gemini.js';
import {
  BANK_ACCOUNTS,
  batchUpdateTransactionCategories,
  getBalancesAsCsv,
  getTransactionsAsCsv,
  getUncategorizedTransactions,
  updateAccountBalance,
} from '../services/sheets.js';

export const telegramRouter = Router();

type ReplyMarkup = {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
};

const QUICK_ACTIONS: Record<string, string> = {
  today_spend: 'How much did I spend today? Break it down by category, account, and merchant.',
  month_summary: 'Summarize my income and expenses this month by account and category.',
  biggest_expenses: 'What are my biggest expenses recently by category?',
  recent_transactions: 'Show my 10 most recent transactions.',
  balance_check: 'What are my latest account balances across Jago, BCA, CIMB Niaga (OCTO), Bank Raya, and Permata ME?',
};

const MAIN_MENU: ReplyMarkup = {
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
  ],
};

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
    await sendTelegramMessage(getHelpText(), MAIN_MENU);
    return res.sendStatus(200);
  }

  if (text === '/balances') {
    const balancesCsv = await getBalancesAsCsv();
    await sendTelegramMessage(`Latest balances:\n\n${balancesCsv}`, MAIN_MENU);
    return res.sendStatus(200);
  }

  if (text?.startsWith('/balance ')) {
    const parsed = parseBalanceCommand(text);
    if (!parsed) {
      await sendTelegramMessage('Use: /balance Jago 1250000');
      return res.sendStatus(200);
    }

    await updateAccountBalance(parsed.sourceOfFund, parsed.amount, parsed.note);
    await sendTelegramMessage(`Updated ${parsed.sourceOfFund} balance to ${parsed.amount}.`, MAIN_MENU);
    return res.sendStatus(200);
  }

  if (text === '/categorize' || callbackQuery?.data === 'categorize') {
    await sendChatAction('typing');
    await sendTelegramMessage('🔍 Reading uncategorized transactions...');

    const uncategorized = await getUncategorizedTransactions();
    if (uncategorized.length === 0) {
      await sendTelegramMessage('✅ All transactions are already categorized!', MAIN_MENU);
      return res.sendStatus(200);
    }

    await sendTelegramMessage(`Found ${uncategorized.length} uncategorized transactions. Asking Gemini to categorize...`);
    await sendChatAction('typing');

    const updates = await categorizeTransactions(uncategorized);
    await batchUpdateTransactionCategories(updates);

    await sendTelegramMessage(`✅ Categorized ${updates.length} transactions!`, MAIN_MENU);
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
    await sendTelegramMessage(answer, MAIN_MENU);
  } catch (err) {
    console.error('Telegram handler error:', err);
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
