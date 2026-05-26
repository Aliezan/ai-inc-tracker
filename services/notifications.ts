import { config } from '../config.js';
import { getAppState, setAppState } from './sheets.js';
import { logError } from './logging.js';
import type { Transaction } from './gemini.js';

const NOTIFICATION_STATE_KEY = 'notifications.enabled';

/**
 * Check whether Telegram notifications for transaction/ingestion events are enabled.
 */
export async function isNotificationsEnabled(): Promise<boolean> {
  const value = await getAppState(NOTIFICATION_STATE_KEY);
  // Default to enabled if no preference has been set yet
  if (value === null) return true;
  return value === 'true';
}

/**
 * Toggle the notification setting and return the new state.
 */
export async function toggleNotifications(): Promise<boolean> {
  const current = await isNotificationsEnabled();
  const next = !current;
  await setAppState(NOTIFICATION_STATE_KEY, String(next));
  return next;
}

/**
 * Set notifications to a specific state.
 */
export async function setNotifications(enabled: boolean): Promise<void> {
  await setAppState(NOTIFICATION_STATE_KEY, String(enabled));
}

// ─── Notification senders ────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('id-ID', {
    style: 'decimal',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

function txDirectionEmoji(type: string): string {
  const lower = type.toLowerCase();
  if (lower.includes('credit') || lower.includes('in') || lower.includes('payroll') || lower.includes('income')) {
    return '💰';
  }
  return '💸';
}

/**
 * Send a notification when a transaction is successfully saved to the sheet.
 */
export async function notifyTransactionSaved(tx: Transaction): Promise<void> {
  if (!(await isNotificationsEnabled())) return;

  const emoji = txDirectionEmoji(tx.transactionType);
  const lines = [
    `${emoji} *Transaction Recorded*`,
    '',
    `🏦 ${tx.sourceOfFund}`,
    `📋 ${tx.transactionType}`,
    ...(tx.beneficiaryMerchant ? [`🏪 ${tx.beneficiaryMerchant}`] : []),
    `🏷 ${tx.category}`,
    `💵 Rp ${formatCurrency(tx.amount)}`,
    ...(tx.balance !== null ? [`📊 Balance: Rp ${formatCurrency(tx.balance)}`] : []),
    `🕐 ${tx.dateTime}`,
  ];

  await sendNotification(lines.join('\n'));
}

/**
 * Send a notification when Gmail webhook processing completes.
 */
export async function notifyIngestionComplete(results: {
  emailsProcessed: number;
  transactionsSaved: number;
  skipped: number;
}): Promise<void> {
  if (!(await isNotificationsEnabled())) return;

  // Don't spam for empty runs
  if (results.emailsProcessed === 0 && results.transactionsSaved === 0) return;

  const lines = [
    '📬 *Gmail Ingestion Complete*',
    '',
    `📧 Emails processed: ${results.emailsProcessed}`,
    `✅ Transactions saved: ${results.transactionsSaved}`,
    `⏭ Skipped: ${results.skipped}`,
  ];

  await sendNotification(lines.join('\n'));
}

// ─── Internal Telegram sender ────────────────────────────────────────────────

async function sendNotification(text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: 'Markdown',
      }),
    });

    if (!res.ok) {
      console.error('Notification sendMessage failed:', await res.text());
    }
  } catch (err) {
    // Notifications should never crash the main flow
    logError('Failed to send notification:', err);
  }
}
