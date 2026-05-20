import { gmail_v1, google } from 'googleapis';
import { config } from '../config';

type MessagePart = gmail_v1.Schema$MessagePart;

function getHeader(part: MessagePart, name: string): string | null {
  return (
    part.headers?.find(header => header.name?.toLowerCase() === name.toLowerCase())?.value ??
    null
  );
}

function getCharset(part: MessagePart): string {
  const contentType = getHeader(part, 'Content-Type') ?? part.mimeType ?? '';
  const match = /charset=["']?([^;"'\s]+)/i.exec(contentType);
  return match?.[1] ?? 'utf-8';
}

function decodeBase64Url(data: string): Buffer {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
}

function decodeWithCharset(buffer: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function decodeQuotedPrintableToBuffer(buffer: Buffer): Buffer {
  const text = buffer.toString('ascii').replace(/=\r?\n/g, '');
  const bytes: number[] = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '=' && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }

  return Buffer.from(bytes);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s+/g, '\n')
      .trim(),
  );
}

function isAttachment(part: MessagePart): boolean {
  const disposition = getHeader(part, 'Content-Disposition') ?? '';
  return /attachment/i.test(disposition) || Boolean(part.body?.attachmentId);
}

export function decodeGmailMessagePart(part: MessagePart): string | null {
  const encoded = part.body?.data;
  if (!encoded) return null;

  let buffer = decodeBase64Url(encoded);
  const transferEncoding = getHeader(part, 'Content-Transfer-Encoding') ?? '';
  if (/quoted-printable/i.test(transferEncoding)) {
    buffer = decodeQuotedPrintableToBuffer(buffer);
  }

  return decodeWithCharset(buffer, getCharset(part));
}

export function extractEmailBody(payload: MessagePart | undefined | null): string | null {
  if (!payload) return null;

  const textParts: string[] = [];
  const htmlParts: string[] = [];

  function visit(part: MessagePart) {
    if (isAttachment(part)) return;

    const mimeType = part.mimeType?.toLowerCase() ?? '';
    if (mimeType === 'text/plain') {
      const decoded = decodeGmailMessagePart(part);
      if (decoded) textParts.push(decoded.trim());
    } else if (mimeType === 'text/html') {
      const decoded = decodeGmailMessagePart(part);
      if (decoded) htmlParts.push(htmlToText(decoded));
    }

    for (const child of part.parts ?? []) {
      visit(child);
    }
  }

  visit(payload);

  const body = textParts.find(Boolean) ?? htmlParts.find(Boolean);
  return body || null;
}

function getMessageHeader(message: gmail_v1.Schema$Message, name: string): string | null {
  return (
    message.payload?.headers
      ?.find(header => header.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? null
  );
}

export function getGmailAuth() {
  const auth = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
  );
  auth.setCredentials({ refresh_token: config.google.refreshToken });
  return auth;
}

export async function getEmailBody(messageId: string): Promise<string | null> {
  const gmail = google.gmail({ version: 'v1', auth: getGmailAuth() });

  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  return extractEmailBody(msg.data.payload);
}

export async function getEmailForTransactionParsing(messageId: string) {
  const gmail = google.gmail({ version: 'v1', auth: getGmailAuth() });

  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  return {
    id: messageId,
    subject: getMessageHeader(msg.data, 'Subject') ?? '',
    from: getMessageHeader(msg.data, 'From') ?? '',
    body: extractEmailBody(msg.data.payload),
  };
}

// Run once to register Gmail push notifications
export async function setupGmailWatch() {
  const gmail = google.gmail({ version: 'v1', auth: getGmailAuth() });

  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: config.pubsub.topicName,
      labelFilterAction: 'include',
      labelIds: ['INBOX'],
    },
  });

  console.log('Gmail watch set up:', res.data);
  return res.data;
}
