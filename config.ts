import 'dotenv/config';

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name: string) {
  return process.env[name] || undefined;
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  publicBaseUrl: optionalEnv('PUBLIC_BASE_URL'),
  webhookSecret: optionalEnv('WEBHOOK_SECRET'),
  telegramWebhookSecret: optionalEnv('TELEGRAM_WEBHOOK_SECRET'),
  geminiApiKey: requiredEnv('GEMINI_API_KEY'),
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  geminiFallbackModel: process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash',
  geminiChatModel: process.env.GEMINI_CHAT_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  sheetId: requiredEnv('SHEET_ID'),
  telegramToken: requiredEnv('TELEGRAM_TOKEN'),
  telegramChatId: requiredEnv('TELEGRAM_CHAT_ID'),
  google: {
    clientId: requiredEnv('GOOGLE_CLIENT_ID'),
    clientSecret: requiredEnv('GOOGLE_CLIENT_SECRET'),
    refreshToken: requiredEnv('GOOGLE_REFRESH_TOKEN'),
  },
  pubsub: {
    topicName: requiredEnv('PUBSUB_TOPIC'),
    projectId: requiredEnv('GOOGLE_PROJECT_ID'),
  },
};
