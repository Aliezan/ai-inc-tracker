import 'dotenv/config';
import { categorizeTransactions } from '../services/gemini.js';
import { batchUpdateTransactionCategories, getUncategorizedTransactions } from '../services/sheets.js';
import { logError } from '../services/logging.js';

async function main() {
  console.log('Reading uncategorized transactions...');
  const uncategorized = await getUncategorizedTransactions();

  if (uncategorized.length === 0) {
    console.log('All transactions are already categorized.');
    return;
  }

  console.log(`Found ${uncategorized.length} uncategorized transactions. Categorizing...`);
  const updates = await categorizeTransactions(uncategorized);
  await batchUpdateTransactionCategories(updates);
  console.log(`Categorized ${updates.length} transactions.`);
}

main().catch(err => {
  logError('Categorization failed:', err);
  process.exit(1);
});
