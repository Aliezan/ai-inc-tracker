type PlainObject = Record<string, unknown>;

const SENSITIVE_KEY = /(authorization|cookie|credential|secret|token|password|api[-_]?key|refresh|access|id_token)/i;
const OMITTED_ERROR_KEYS = new Set(['config', 'request', 'headers', 'body', 'data']);

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;
  if (depth > 3) return '[Truncated]';

  if (Array.isArray(value)) {
    return value.map(item => sanitize(item, depth + 1));
  }

  if (value instanceof URLSearchParams) {
    return sanitize(Object.fromEntries(value.entries()), depth + 1);
  }

  const output: PlainObject = {};
  for (const [key, entry] of Object.entries(value as PlainObject)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = '[REDACTED]';
      continue;
    }

    output[key] = sanitize(entry, depth + 1);
  }

  return output;
}

export function formatErrorForLog(err: unknown): unknown {
  if (!isPlainObject(err)) return err;

  const error = err as unknown as Error & {
    code?: unknown;
    status?: unknown;
    cause?: unknown;
    response?: {
      status?: unknown;
      statusText?: unknown;
      data?: unknown;
    };
  };

  const formatted: PlainObject = {
    name: error.name,
    message: error.message,
    code: error.code,
    status: error.status,
  };

  if (error.response) {
    formatted.response = {
      status: error.response.status,
      statusText: error.response.statusText,
      data: sanitize(error.response.data),
    };
  }

  if (error.cause && isPlainObject(error.cause)) {
    formatted.cause = sanitize(error.cause);
  }

  if (error.stack) {
    formatted.stack = error.stack;
  }

  for (const [key, value] of Object.entries(error)) {
    if (key in formatted || OMITTED_ERROR_KEYS.has(key)) continue;
    if (SENSITIVE_KEY.test(key)) {
      formatted[key] = '[REDACTED]';
      continue;
    }
    formatted[key] = sanitize(value);
  }

  return formatted;
}

export function logError(message: string, err: unknown) {
  console.error(message, formatErrorForLog(err));
}

export function isInvalidGrantError(err: unknown): boolean {
  if (!isPlainObject(err)) return false;

  const error = err as {
    message?: unknown;
    response?: {
      data?: {
        error?: unknown;
      };
    };
  };

  return error.message === 'invalid_grant' || error.response?.data?.error === 'invalid_grant';
}
