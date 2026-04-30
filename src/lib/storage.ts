import type { PaymentRequest, PaymentStatus, Receipt } from "./payments";
import {
  formatTokenAmount,
  isPaymentToken,
  normalizeDateTime,
  normalizeInvoiceDate,
  normalizeLabel,
  normalizeNote,
  parseTokenAmount,
  refreshDerivedStatus,
  toExplorerTxUrl,
  validateRecipient
} from "./payments";

export const REQUESTS_KEY = "disburse.requests";
export const RECEIPTS_KEY = "disburse.receipts";
const LEGACY_REQUESTS_KEY = "arc-pay-desk.requests";
const LEGACY_RECEIPTS_KEY = "arc-pay-desk.receipts";

export type ExportBundle = {
  exportedAt: string;
  requests: PaymentRequest[];
  receipts: Receipt[];
};

export function loadRequests(): PaymentRequest[] {
  return readJsonFromKeys<unknown[]>([REQUESTS_KEY, LEGACY_REQUESTS_KEY], [])
    .map(normalizeImportedRequest)
    .filter((request): request is PaymentRequest => Boolean(request));
}

export function saveRequests(requests: PaymentRequest[]) {
  localStorage.setItem(REQUESTS_KEY, JSON.stringify(requests));
}

export function upsertRequest(requests: PaymentRequest[], next: PaymentRequest): PaymentRequest[] {
  const index = requests.findIndex((request) => request.id === next.id);
  if (index === -1) {
    return [next, ...requests];
  }
  const copy = [...requests];
  copy[index] = next;
  return copy;
}

export function loadReceipts(): Receipt[] {
  return readJsonFromKeys<unknown[]>([RECEIPTS_KEY, LEGACY_RECEIPTS_KEY], [])
    .map(normalizeImportedReceipt)
    .filter((receipt): receipt is Receipt => Boolean(receipt));
}

export function saveReceipts(receipts: Receipt[]) {
  localStorage.setItem(RECEIPTS_KEY, JSON.stringify(receipts));
}

export function upsertReceipt(receipts: Receipt[], next: Receipt): Receipt[] {
  const index = receipts.findIndex((receipt) => receipt.requestId === next.requestId || receipt.txHash === next.txHash);
  if (index === -1) {
    return [next, ...receipts];
  }
  const copy = [...receipts];
  copy[index] = next;
  return copy;
}

export function buildExportBundle(requests: PaymentRequest[], receipts: Receipt[]): ExportBundle {
  return {
    exportedAt: new Date().toISOString(),
    requests,
    receipts
  };
}

export function parseExportBundle(value: string): ExportBundle {
  const parsed = JSON.parse(value) as Partial<ExportBundle>;
  if (!Array.isArray(parsed.requests) || !Array.isArray(parsed.receipts)) {
    throw new Error("Import file is missing requests or receipts.");
  }
  return {
    exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : new Date().toISOString(),
    requests: parsed.requests
      .map(normalizeImportedRequest)
      .filter((request): request is PaymentRequest => Boolean(request)),
    receipts: parsed.receipts
      .map(normalizeImportedReceipt)
      .filter((receipt): receipt is Receipt => Boolean(receipt))
  };
}

function normalizeImportedRequest(value: unknown): PaymentRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  try {
    const token = value.token;
    if (!isPaymentToken(token)) {
      return undefined;
    }
    const startBlock = BigInt(readRequiredString(value, "startBlock"));
    if (startBlock < 0n) {
      return undefined;
    }

    const request: PaymentRequest = {
      id: readRequiredString(value, "id"),
      recipient: validateRecipient(readRequiredString(value, "recipient")),
      token,
      amount: formatTokenAmount(parseTokenAmount(readRequiredString(value, "amount"), token), token),
      label: normalizeLabel(readRequiredString(value, "label")),
      note: readOptionalString(value, "note") ? normalizeNote(readOptionalString(value, "note") ?? "") : undefined,
      invoiceDate: readOptionalString(value, "invoiceDate")
        ? normalizeInvoiceDate(readOptionalString(value, "invoiceDate") ?? "")
        : undefined,
      expiresAt: readOptionalString(value, "expiresAt")
        ? normalizeDateTime(readOptionalString(value, "expiresAt") ?? "", "expiry time")
        : undefined,
      dueAt: readOptionalString(value, "dueAt")
        ? normalizeDateTime(readOptionalString(value, "dueAt") ?? "", "due time")
        : undefined,
      createdAt: normalizeDateTime(readRequiredString(value, "createdAt"), "creation time"),
      submittedAt: readOptionalString(value, "submittedAt")
        ? normalizeDateTime(readOptionalString(value, "submittedAt") ?? "", "submission time")
        : undefined,
      startBlock: String(startBlock),
      status: readPaymentStatus(value.status),
      txHash: readHash(value.txHash)
    };

    return refreshDerivedStatus(request);
  } catch {
    return undefined;
  }
}

function normalizeImportedReceipt(value: unknown): Receipt | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  try {
    const token = value.token;
    const txHash = readHash(value.txHash);
    if (!isPaymentToken(token) || !txHash) {
      return undefined;
    }
    const blockNumber = BigInt(readRequiredString(value, "blockNumber"));
    if (blockNumber < 0n) {
      return undefined;
    }

    return {
      requestId: readRequiredString(value, "requestId"),
      txHash,
      from: validateRecipient(readRequiredString(value, "from")),
      to: validateRecipient(readRequiredString(value, "to")),
      token,
      amount: formatTokenAmount(parseTokenAmount(readRequiredString(value, "amount"), token), token),
      blockNumber: String(blockNumber),
      confirmedAt: normalizeDateTime(readRequiredString(value, "confirmedAt"), "confirmation time"),
      explorerUrl: toExplorerTxUrl(txHash)
    };
  } catch {
    return undefined;
  }
}

function readPaymentStatus(value: unknown): PaymentStatus {
  return value === "paid" || value === "possible_match" || value === "expired" || value === "failed" ? value : "open";
}

function readHash(value: unknown): `0x${string}` | undefined {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    return undefined;
  }
  return value as `0x${string}`;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    if (!value) {
      return fallback;
    }
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function readJsonFromKeys<T>(keys: string[], fallback: T): T {
  for (const key of keys) {
    const value = readJson<T | undefined>(key, undefined);
    if (value !== undefined) {
      return value;
    }
  }
  return fallback;
}
