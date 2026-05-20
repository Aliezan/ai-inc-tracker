import { google } from 'googleapis';
import { config } from '../config.js';
import { Transaction } from './gemini.js';

export const SPREADSHEET_TITLE = 'MoneyTrackerBOT-trx-log';
const LEGACY_TRANSACTION_SHEET_NAME = 'Transactions';

export const TRANSACTION_SHEETS = {
  real: 'MoneyTrackerBOT Trx Log',
  test: 'Test-Transactions',
  balances: 'Account-Balances',
  state: 'System-State',
} as const;

export const TRANSACTION_HEADERS = [
  'Source of Fund',
  'Transaction Type',
  'Beneficiary/Merchant',
  'Category',
  'Amount',
  'Balance',
  'Date/Time',
];

export const BANK_ACCOUNTS = ['Jago', 'BCA', 'CIMB Niaga (OCTO)', 'Bank Raya', 'Permata ME'] as const;

export const BALANCE_HEADERS = ['Source of Fund', 'Balance', 'Updated At', 'Note'];
export const STATE_HEADERS = ['Key', 'Value', 'Updated At'];

const DATA_START_ROW = 3;

function getAuth() {
  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
  );
  auth.setCredentials({ refresh_token: config.google.refreshToken });
  return auth;
}

function quoteSheetName(sheetName: string) {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

export function normalizeBankAccount(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (normalized.includes('jago')) return 'Jago';
  if (normalized.includes('bca')) return 'BCA';
  if (normalized.includes('cimb') || normalized.includes('octo')) return 'CIMB Niaga (OCTO)';
  if (normalized.includes('raya')) return 'Bank Raya';
  if (normalized.includes('permata')) return 'Permata ME';

  return null;
}

type AppendTransactionOptions = {
  sheetName?: string;
};

export async function appendTransaction(tx: Transaction, options: AppendTransactionOptions = {}) {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const sheetName = options.sheetName ?? TRANSACTION_SHEETS.real;

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `${quoteSheetName(sheetName)}!A${DATA_START_ROW}:G`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        tx.sourceOfFund,
        tx.transactionType,
        tx.beneficiaryMerchant ?? '',
        tx.category,
        tx.amount,
        tx.balance ?? '',
        tx.dateTime,
      ]],
    },
  });
}

export async function appendTestTransaction(tx: Transaction) {
  await appendTransaction(tx, { sheetName: TRANSACTION_SHEETS.test });
}

export async function getTransactionsAsCsv(limit = 100): Promise<string> {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${quoteSheetName(TRANSACTION_SHEETS.real)}!A${DATA_START_ROW}:G`,
  });

  const rows = res.data.values ?? [];
  if (rows.length === 0) return 'No transactions yet.';

  const recent = rows.slice(-limit);
  return [TRANSACTION_HEADERS.join(','), ...recent.map(r => r.join(','))].join('\n');
}

export async function getBalancesAsCsv(): Promise<string> {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${quoteSheetName(TRANSACTION_SHEETS.balances)}!A${DATA_START_ROW}:D`,
  });

  const rows = res.data.values ?? [];
  if (rows.length === 0) return BALANCE_HEADERS.join(',');

  return [BALANCE_HEADERS.join(','), ...rows.map(r => r.join(','))].join('\n');
}

export async function updateAccountBalance(sourceOfFund: string, balance: number, note = '') {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const normalized = normalizeBankAccount(sourceOfFund);

  if (!normalized) {
    throw new Error(`Unknown bank account: ${sourceOfFund}`);
  }

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${quoteSheetName(TRANSACTION_SHEETS.balances)}!A${DATA_START_ROW}:D`,
  });

  const rows = res.data.values ?? [];
  const rowIndex = rows.findIndex(row => row[0] === normalized);
  const values = [[normalized, balance, new Date().toISOString(), note]];

  if (rowIndex >= 0) {
    const sheetRow = DATA_START_ROW + rowIndex;
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: `${quoteSheetName(TRANSACTION_SHEETS.balances)}!A${sheetRow}:D${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `${quoteSheetName(TRANSACTION_SHEETS.balances)}!A${DATA_START_ROW}:D`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

export async function resetTransactionLogs(options: { includeTest?: boolean; includeBalances?: boolean } = {}) {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const sheetNames = [
    TRANSACTION_SHEETS.real,
    ...(options.includeTest ? [TRANSACTION_SHEETS.test] : []),
    ...(options.includeBalances ? [TRANSACTION_SHEETS.balances] : []),
  ];

  await Promise.all(
    sheetNames.map(sheetName =>
      sheets.spreadsheets.values.clear({
        spreadsheetId: config.sheetId,
        range: `${quoteSheetName(sheetName)}!A${DATA_START_ROW}:Z`,
      }),
    ),
  );

  if (options.includeBalances) {
    await seedBalanceRows();
  }
}

export async function getAppState(key: string): Promise<string | null> {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${quoteSheetName(TRANSACTION_SHEETS.state)}!A2:C`,
  });

  const row = (res.data.values ?? []).find(item => item[0] === key);
  return row?.[1] ?? null;
}

export async function setAppState(key: string, value: string) {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${quoteSheetName(TRANSACTION_SHEETS.state)}!A2:C`,
  });

  const rows = res.data.values ?? [];
  const rowIndex = rows.findIndex(row => row[0] === key);
  const values = [[key, value, new Date().toISOString()]];

  if (rowIndex >= 0) {
    const sheetRow = 2 + rowIndex;
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheetId,
      range: `${quoteSheetName(TRANSACTION_SHEETS.state)}!A${sheetRow}:C${sheetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `${quoteSheetName(TRANSACTION_SHEETS.state)}!A2:C`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

function getHeadersForSheet(sheetName: string) {
  if (sheetName === TRANSACTION_SHEETS.state) return STATE_HEADERS;
  return sheetName === TRANSACTION_SHEETS.balances ? BALANCE_HEADERS : TRANSACTION_HEADERS;
}

function getSummaryRowForSheet(sheetName: string) {
  if (sheetName === TRANSACTION_SHEETS.state) {
    return ['gmail.lastHistoryId', '', 'Persistent Gmail cursor used by webhook processing'];
  }

  if (sheetName === TRANSACTION_SHEETS.balances) {
    return [
      'TOTAL',
      `=SUM(B${DATA_START_ROW}:B)`,
      '',
      'Current total balance across all accounts',
    ];
  }

  return [
    'TOTAL',
    '',
    '',
    '',
    `=SUM(E${DATA_START_ROW}:E)`,
    `=IFERROR(LOOKUP(2,1/(F${DATA_START_ROW}:F<>""),F${DATA_START_ROW}:F),"")`,
    'Total amount / latest balance',
  ];
}

async function seedBalanceRows() {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const existingBalances = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetId,
    range: `${quoteSheetName(TRANSACTION_SHEETS.balances)}!A${DATA_START_ROW}:A`,
  });

  const existingAccountNames = new Set((existingBalances.data.values ?? []).map(row => row[0]));
  const missingAccounts = BANK_ACCOUNTS.filter(account => !existingAccountNames.has(account));

  if (missingAccounts.length === 0) return;

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.sheetId,
    range: `${quoteSheetName(TRANSACTION_SHEETS.balances)}!A${DATA_START_ROW}:D`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: missingAccounts.map(account => [account, '', '', '']),
    },
  });
}

export async function setupTransactionSheets() {
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: config.sheetId,
  });

  const existingSheets = new Map(
    spreadsheet.data.sheets
      ?.map(sheet => sheet.properties)
      .filter((properties): properties is NonNullable<typeof properties> => Boolean(properties))
      .map(properties => [properties.title, properties.sheetId]) ?? [],
  );

  const legacyTransactionSheetId = existingSheets.get(LEGACY_TRANSACTION_SHEET_NAME);
  if (
    legacyTransactionSheetId !== undefined &&
    !existingSheets.has(TRANSACTION_SHEETS.real)
  ) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: {
        requests: [
          {
            updateSheetProperties: {
              properties: {
                sheetId: legacyTransactionSheetId,
                title: TRANSACTION_SHEETS.real,
              },
              fields: 'title',
            },
          },
        ],
      },
    });

    existingSheets.delete(LEGACY_TRANSACTION_SHEET_NAME);
    existingSheets.set(TRANSACTION_SHEETS.real, legacyTransactionSheetId);
  }

  const desiredSheetNames = Object.values(TRANSACTION_SHEETS);
  const missingSheetNames = desiredSheetNames.filter(sheetName => !existingSheets.has(sheetName));

  const setupRequests = [
    {
      updateSpreadsheetProperties: {
        properties: {
          title: SPREADSHEET_TITLE,
        },
        fields: 'title',
      },
    },
    ...missingSheetNames.map(title => ({
      addSheet: {
        properties: {
          title,
          gridProperties: {
            frozenRowCount: 1,
          },
        },
      },
    })),
  ];

  if (setupRequests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.sheetId,
      requestBody: {
        requests: setupRequests,
      },
    });
  }

  const updatedSpreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: config.sheetId,
  });

  const sheetIds = new Map(
    updatedSpreadsheet.data.sheets
      ?.map(sheet => sheet.properties)
      .filter((properties): properties is NonNullable<typeof properties> => Boolean(properties))
      .map(properties => [properties.title, properties.sheetId]) ?? [],
  );

  await Promise.all(
    desiredSheetNames.map(sheetName => {
      const headers = getHeadersForSheet(sheetName);
      const endColumn = String.fromCharCode(64 + headers.length);

      return sheets.spreadsheets.values.update({
        spreadsheetId: config.sheetId,
        range: `${quoteSheetName(sheetName)}!A1:${endColumn}1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [headers],
        },
      });
    }),
  );

  await Promise.all(
    desiredSheetNames.map(sheetName => {
      const summaryRow = getSummaryRowForSheet(sheetName);
      const endColumn = String.fromCharCode(64 + summaryRow.length);

      return sheets.spreadsheets.values.update({
        spreadsheetId: config.sheetId,
        range: `${quoteSheetName(sheetName)}!A2:${endColumn}2`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [summaryRow],
        },
      });
    }),
  );

  await seedBalanceRows();

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: config.sheetId,
    requestBody: {
      requests: desiredSheetNames.flatMap(sheetName => {
        const sheetId = sheetIds.get(sheetName);
        if (sheetId === undefined || sheetId === null) return [];

        const headers = getHeadersForSheet(sheetName);

        return [
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: {
                  frozenRowCount: 1,
                },
              },
              fields: 'gridProperties.frozenRowCount',
            },
          },
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: headers.length,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: {
                    red: 0.9,
                    green: 0.94,
                    blue: 1,
                  },
                  textFormat: {
                    bold: true,
                  },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 1,
                endRowIndex: 2,
                startColumnIndex: 0,
                endColumnIndex: headers.length,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: {
                    red: 0.94,
                    green: 0.98,
                    blue: 0.92,
                  },
                  textFormat: {
                    bold: true,
                  },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: headers.length,
              },
            },
          },
        ];
      }),
    },
  });
}
