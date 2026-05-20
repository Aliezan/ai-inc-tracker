import { config } from '../config.js';

export async function sendTelegramMessage(text: string) {
  const chunks = splitTelegramMessage(text);

  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: chunk,
      }),
    });

    if (!res.ok) {
      throw new Error(`Telegram sendMessage failed: ${await res.text()}`);
    }
  }
}

function splitTelegramMessage(text: string) {
  const maxLength = 3900;
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const splitAt = remaining.lastIndexOf('\n', maxLength);
    const end = splitAt > 0 ? splitAt : maxLength;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end).trimStart();
  }

  if (remaining) chunks.push(remaining);

  return chunks;
}
