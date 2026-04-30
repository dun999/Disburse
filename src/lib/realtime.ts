import type { Hash } from "viem";
import type { PaymentRequest, PaymentStatus, PaymentToken, Receipt } from "./payments.js";

export type QrRealtimeEventType = "submitted" | "paid" | "failed" | "expired";

export type PaymentRequestRow = {
  id: string;
  recipient: string;
  token: PaymentToken;
  amount: string;
  label: string;
  note: string | null;
  invoice_date: string | null;
  expires_at: string | null;
  due_at: string | null;
  created_at: string;
  submitted_at: string | null;
  start_block: string;
  status: PaymentStatus;
  tx_hash: string | null;
  failure_reason: string | null;
  updated_at?: string;
};

export type PaymentReceiptRow = {
  request_id: string;
  tx_hash: string;
  payer: string;
  recipient: string;
  token: PaymentToken;
  amount: string;
  block_number: string;
  confirmed_at: string;
  explorer_url: string;
};

export type QrRealtimeEvent = {
  id?: number;
  request_id: string;
  event_type: QrRealtimeEventType;
  status: PaymentStatus;
  message: string;
  tx_hash?: string | null;
  submitted_at?: string | null;
  receipt?: Receipt | null;
  created_at?: string;
};

export type QrStatusPayload = {
  request: PaymentRequest;
  receipt?: Receipt;
  event?: QrRealtimeEvent;
  message?: string;
};

export type AppliedQrEvent = {
  request: PaymentRequest;
  receipt?: Receipt;
  message: string;
};

export function paymentRequestToRow(request: PaymentRequest, failureReason?: string): PaymentRequestRow {
  return {
    id: request.id,
    recipient: request.recipient,
    token: request.token,
    amount: request.amount,
    label: request.label,
    note: request.note ?? null,
    invoice_date: request.invoiceDate ?? null,
    expires_at: request.expiresAt ?? null,
    due_at: request.dueAt ?? null,
    created_at: request.createdAt,
    submitted_at: request.submittedAt ?? null,
    start_block: request.startBlock,
    status: request.status,
    tx_hash: request.txHash ?? null,
    failure_reason: failureReason ?? null
  };
}

export function rowToPaymentRequest(row: PaymentRequestRow): PaymentRequest {
  return {
    id: row.id,
    recipient: row.recipient as `0x${string}`,
    token: row.token,
    amount: row.amount,
    label: row.label,
    note: row.note ?? undefined,
    invoiceDate: row.invoice_date ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    dueAt: row.due_at ?? undefined,
    createdAt: row.created_at,
    submittedAt: row.submitted_at ?? undefined,
    startBlock: row.start_block,
    status: row.status,
    txHash: normalizeHash(row.tx_hash)
  };
}

export function receiptToRow(receipt: Receipt): PaymentReceiptRow {
  return {
    request_id: receipt.requestId,
    tx_hash: receipt.txHash,
    payer: receipt.from,
    recipient: receipt.to,
    token: receipt.token,
    amount: receipt.amount,
    block_number: receipt.blockNumber,
    confirmed_at: receipt.confirmedAt,
    explorer_url: receipt.explorerUrl
  };
}

export function rowToReceipt(row: PaymentReceiptRow): Receipt {
  return {
    requestId: row.request_id,
    txHash: row.tx_hash as Hash,
    from: row.payer as `0x${string}`,
    to: row.recipient as `0x${string}`,
    token: row.token,
    amount: row.amount,
    blockNumber: row.block_number,
    confirmedAt: row.confirmed_at,
    explorerUrl: row.explorer_url
  };
}

export function applyQrRealtimeEvent(request: PaymentRequest, event: QrRealtimeEvent): AppliedQrEvent {
  const receipt = normalizeReceipt(event.receipt);
  return {
    request: {
      ...request,
      status: event.status,
      txHash: normalizeHash(event.tx_hash) ?? receipt?.txHash ?? request.txHash,
      submittedAt: event.submitted_at ?? request.submittedAt
    },
    receipt,
    message: event.message
  };
}

export function shouldHideQrForStatus(status: PaymentStatus): boolean {
  return status === "paid" || status === "failed" || status === "expired";
}

export function isFinalQrStatus(status: PaymentStatus): boolean {
  return shouldHideQrForStatus(status);
}

function normalizeHash(value: string | null | undefined): Hash | undefined {
  if (typeof value !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    return undefined;
  }
  return value as Hash;
}

function normalizeReceipt(value: Receipt | null | undefined): Receipt | undefined {
  return value ?? undefined;
}
