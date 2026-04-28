import type { PaymentRequest, Receipt } from "./payments";
import { refreshDerivedStatus } from "./payments";

const REQUESTS_KEY = "disburse.requests";
const RECEIPTS_KEY = "disburse.receipts";
const LEGACY_REQUESTS_KEY = "arc-pay-desk.requests";
const LEGACY_RECEIPTS_KEY = "arc-pay-desk.receipts";

export type ExportBundle = {
  exportedAt: string;
  requests: PaymentRequest[];
  receipts: Receipt[];
};

export function loadRequests(): PaymentRequest[] {
  return readJsonFromKeys<PaymentRequest[]>([REQUESTS_KEY, LEGACY_REQUESTS_KEY], []).map((request) =>
    refreshDerivedStatus(request)
  );
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
  return readJsonFromKeys<Receipt[]>([RECEIPTS_KEY, LEGACY_RECEIPTS_KEY], []);
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
    requests: parsed.requests as PaymentRequest[],
    receipts: parsed.receipts as Receipt[]
  };
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
