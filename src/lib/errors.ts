const TXPOOL_FULL_PATTERN = /\btxpool\s+is\s+full\b/i;

export function errorToMessage(error: unknown): string {
  if (isTxPoolFullError(error)) {
    return "Arc Testnet transaction pool is full right now. No transaction hash was returned; wait a minute, then retry Pay request.";
  }

  const message = readPreferredMessage(error);
  return message ?? "Something went wrong.";
}

export function isTxPoolFullError(error: unknown): boolean {
  return collectErrorText(error).some((text) => TXPOOL_FULL_PATTERN.test(text));
}

function readPreferredMessage(error: unknown): string | undefined {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  if ("shortMessage" in error && typeof error.shortMessage === "string" && error.shortMessage.trim()) {
    return error.shortMessage;
  }

  if ("message" in error && typeof error.message === "string" && error.message.trim()) {
    return error.message;
  }

  return undefined;
}

function collectErrorText(error: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof error === "string") {
    return [error];
  }

  if (typeof error !== "object" || error === null || seen.has(error)) {
    return [];
  }

  seen.add(error);

  const texts: string[] = [];
  for (const key of ["shortMessage", "message", "details", "name"]) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "string") {
      texts.push(value);
    }
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause) {
    texts.push(...collectErrorText(cause, seen));
  }

  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const item of errors) {
      texts.push(...collectErrorText(item, seen));
    }
  }

  return texts;
}
