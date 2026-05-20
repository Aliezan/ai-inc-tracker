import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import { config } from '../config.js';

const ai = new GoogleGenerativeAI(config.geminiApiKey);

export interface Transaction {
  sourceOfFund: 'Jago' | 'BCA' | 'CIMB Niaga (OCTO)' | 'Bank Raya' | 'Permata ME' | 'Unknown';
  transactionType: string;
  beneficiaryMerchant: string | null;
  category: string;
  amount: number;
  balance: number | null;
  dateTime: string;
}

const transactionSchema = z.object({
  sourceOfFund: z.enum(['Jago', 'BCA', 'CIMB Niaga (OCTO)', 'Bank Raya', 'Permata ME', 'Unknown']),
  transactionType: z.string().min(1),
  beneficiaryMerchant: z.string().nullable(),
  category: z.string().min(1),
  amount: z.number().positive(),
  balance: z.number().nullable(),
  dateTime: z.string().min(1),
});

const transactionResponseSchema = z.union([
  transactionSchema,
  z.object({ transaction: z.null() }),
  z.null(),
]);

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getModelNames() {
  return [...new Set([config.geminiModel, config.geminiFallbackModel].filter(Boolean))];
}

function isRetryableGeminiError(err: unknown) {
  const status = (err as { status?: number })?.status;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function generateTransactionJson(prompt: string) {
  let lastError: unknown;

  for (const modelName of getModelNames()) {
    const model = ai.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: 'application/json' },
    });

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (err) {
        lastError = err;
        if (!isRetryableGeminiError(err) || attempt === 3) break;

        console.warn(`Gemini ${modelName} failed with a retryable error. Retry ${attempt}/2...`);
        await sleep(500 * attempt);
      }
    }

    console.warn(`Gemini model ${modelName} did not return a usable response. Trying fallback if configured.`);
  }

  throw lastError;
}

type EmailMetadata = {
  from?: string;
  subject?: string;
};

export async function parseEmailToTransaction(
  emailBody: string,
  metadata: EmailMetadata = {},
): Promise<Transaction | null> {
  const prompt = `
    Extract transaction info from this bank notification email.
    If the email is not a bank transaction notification, return ONLY:
    {"transaction": null}

    Otherwise return ONLY a JSON object with fields:
    sourceOfFund ("Jago", "BCA", "CIMB Niaga (OCTO)", "Bank Raya", or "Unknown"),
    transactionType (specific banking action, for example "QRIS Payment", "Transfer Out", "Transfer In", "Card Purchase", "Bill Payment", "Cash Withdrawal", "Bank Fee"),
    beneficiaryMerchant (merchant, recipient, sender, or beneficiary name, string or null),
    category (one short category string),
    amount (number),
    balance (number or null),
    dateTime (ISO 8601).

    Category rules:
    - Include timing context and spending context when useful.
    - Use "Weekday Worktime" if the transaction happens Monday-Friday from 07:30 through 16:30.
    - Use "Commute Home" if the transaction happens Monday-Friday from 16:00 through 19:00 and looks like transport, QRIS, transit, fuel, parking, toll, convenience store, snack, coffee, or dinner on the way home.
    - Use "Weekend" if the transaction happens Saturday or Sunday.
    - Use "Off-hours" for weekday transactions outside worktime/commute windows.
    - For payroll/income, use "Payroll" or "Income" even if it happens during worktime.
    - For bank transfers, use "Transfer" with timing context only if the beneficiary/description suggests personal spending.
    - Examples: "Weekday Worktime - Food", "Commute Home - QRIS", "Weekend - Shopping", "Payroll", "Transfer Out".

    Use the email sender and subject to infer sourceOfFund when possible:
    - Jago for Bank Jago/Jago senders
    - BCA for BCA senders
    - CIMB Niaga (OCTO) for CIMB/OCTO senders
    - Bank Raya for Bank Raya/Raya senders
    - Permata ME for Permata/PermataBank/Permata ME senders

    Email sender:
    ${metadata.from ?? 'Unknown'}

    Email subject:
    ${metadata.subject ?? 'Unknown'}

    Email:
    ${emailBody}
  `;

  try {
    const text = await generateTransactionJson(prompt);
    const parsed = transactionResponseSchema.safeParse(JSON.parse(text));

    if (!parsed.success) {
      console.warn('Gemini returned invalid transaction JSON:', parsed.error.flatten());
      return null;
    }

    if (parsed.data === null || 'transaction' in parsed.data) {
      return null;
    }

    return parsed.data;
  } catch (err) {
    console.error('Gemini parse error:', err);
    return null;
  }
}

const chatModel = ai.getGenerativeModel({ model: config.geminiChatModel });

export async function answerQuestion(question: string, csvData: string, balancesCsv: string): Promise<string> {
  const prompt = `
    You are a personal finance assistant.
    Here are the user's recent transactions in CSV:
    ${csvData}

    Here are the user's latest account balances in CSV:
    ${balancesCsv}

    Answer this question concisely.
    The user has 5 bank accounts: Jago, BCA, CIMB Niaga (OCTO), Bank Raya, and Permata ME.
    Use Source of Fund and Category to group spending, workday behavior, commute spending, weekend spending, and banking habits.
    Include a short "Checked:" line that names the spreadsheet data you used and any obvious limitation.
    Do not include hidden reasoning or chain-of-thought.

    Question:
    ${question}
  `;

  const result = await chatModel.generateContent(prompt);
  return result.response.text();
}

export async function summarizeMoneyReport(
  reportName: string,
  csvData: string,
  balancesCsv: string,
): Promise<string> {
  const prompt = `
    You are a personal finance reporting assistant.

    Report name:
    ${reportName}

    Recent transactions CSV:
    ${csvData}

    Latest account balances CSV:
    ${balancesCsv}

    Write a Telegram-friendly money report with complete details.
    Include:
    1. Spending total, incoming total, and net movement if inferable from transaction type/category.
    2. Breakdown by Source of Fund.
    3. Breakdown by Category, including worktime, commute home, weekend, and off-hours patterns when present.
    4. Largest outgoing transactions with merchant/beneficiary, account, category, amount, and date/time.
    5. Incoming money details, especially payroll/income.
    6. Current balances by account and total balance.
    7. Practical observations, but do not invent data.

    Use concise section headings.
    If transaction direction is ambiguous, say so and explain which totals may be approximate.
    Do not include hidden reasoning or chain-of-thought.
  `;

  const result = await chatModel.generateContent(prompt);
  return result.response.text();
}
