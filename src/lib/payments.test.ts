import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import { erc20Abi, TOKENS } from "./arc";
import {
  buildShareUrl,
  createExpiry,
  decodeRequestPayload,
  decodeTransferLog,
  encodeRequestPayload,
  formatTokenAmount,
  isPaymentExpired,
  isPaymentPayable,
  mergeScannedRequest,
  normalizeInvoiceDate,
  parseTokenAmount,
  transferMatchesRequest,
  validateRecipient,
  type PaymentRequest
} from "./payments";

const recipient = validateRecipient("0x1111111111111111111111111111111111111111");
const sender = validateRecipient("0x2222222222222222222222222222222222222222");

const baseRequest: PaymentRequest = {
  id: "req_test_001",
  recipient,
  token: "USDC",
  amount: "12.34",
  label: "Invoice 7421",
  note: "Settlement desk",
  invoiceDate: "2026-04-28",
  expiresAt: "2026-04-28T00:15:00.000Z",
  createdAt: "2026-04-28T00:00:00.000Z",
  startBlock: "700",
  status: "open"
};

function encodeRawPayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

describe("payment amount conversion", () => {
  it("parses and formats 6-decimal stablecoin amounts", () => {
    expect(parseTokenAmount("1", "USDC")).toBe(1_000_000n);
    expect(parseTokenAmount("1.234567", "USDC")).toBe(1_234_567n);
    expect(formatTokenAmount(1_230_000n, "USDC")).toBe("1.23");
  });

  it("rejects malformed amounts and excessive decimals", () => {
    expect(() => parseTokenAmount("0", "USDC")).toThrow("greater than zero");
    expect(() => parseTokenAmount("1.2345678", "USDC")).toThrow("6 decimals");
    expect(() => parseTokenAmount("1,000", "USDC")).toThrow("6 decimals");
  });
});

describe("request payload URLs", () => {
  it("round-trips share payloads through base64url JSON", () => {
    const encoded = encodeRequestPayload(baseRequest);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");

    const decoded = decodeRequestPayload(encoded);
    expect(decoded).toMatchObject({
      id: baseRequest.id,
      recipient: baseRequest.recipient,
      token: baseRequest.token,
      amount: baseRequest.amount,
      label: baseRequest.label,
      note: baseRequest.note,
      invoiceDate: baseRequest.invoiceDate,
      expiresAt: baseRequest.expiresAt,
      startBlock: baseRequest.startBlock,
      status: "open"
    });
  });

  it("builds the /pay request URL", () => {
    expect(buildShareUrl(baseRequest, "https://desk.example")).toMatch(/^https:\/\/desk\.example\/pay\?r=/);
  });
});

describe("QR request metadata", () => {
  it("normalizes invoice dates and keeps them separate from expiry", () => {
    expect(normalizeInvoiceDate("2026-04-29")).toBe("2026-04-29");
    expect(createExpiry("2026-04-29T10:00:00.000Z")).toBe("2026-04-29T10:15:00.000Z");
    expect(() => normalizeInvoiceDate("04/29/26")).toThrow("valid invoice date");
    expect(() => normalizeInvoiceDate("2026-02-31")).toThrow("valid invoice date");
  });

  it("blocks expired QR requests unless a payment attempt started before expiry", () => {
    const afterExpiry = new Date("2026-04-28T00:16:00.000Z");
    expect(isPaymentExpired(baseRequest, afterExpiry)).toBe(true);
    expect(isPaymentPayable(baseRequest, afterExpiry)).toBe(false);
    expect(
      isPaymentPayable(
        {
          ...baseRequest,
          submittedAt: "2026-04-28T00:14:59.000Z"
        },
        afterExpiry
      )
    ).toBe(true);
  });
});

describe("scanned request recovery", () => {
  it("preserves a submitted local transaction when the same QR is reopened", () => {
    const txHash = `0x${"b".repeat(64)}` as `0x${string}`;
    const scanned = decodeRequestPayload(encodeRequestPayload(baseRequest));
    const merged = mergeScannedRequest(
      {
        ...baseRequest,
        submittedAt: "2026-04-28T00:03:00.000Z",
        status: "paid",
        txHash
      },
      scanned
    );

    expect(merged).toMatchObject({
      id: baseRequest.id,
      status: "paid",
      submittedAt: "2026-04-28T00:03:00.000Z",
      txHash
    });
  });

  it("rejects malformed request date fields from QR payloads", () => {
    expect(() =>
      decodeRequestPayload(
        encodeRawPayload({
          version: 1,
          id: baseRequest.id,
          recipient: baseRequest.recipient,
          token: baseRequest.token,
          amount: baseRequest.amount,
          label: baseRequest.label,
          expiresAt: "not-a-date",
          createdAt: baseRequest.createdAt,
          startBlock: baseRequest.startBlock
        })
      )
    ).toThrow("expiry time");
  });
});

describe("address validation", () => {
  it("normalizes valid addresses and rejects invalid values", () => {
    expect(validateRecipient("0x1111111111111111111111111111111111111111")).toBe(recipient);
    expect(() => validateRecipient("arc")).toThrow("valid 0x");
  });
});

describe("transfer log matching", () => {
  it("decodes ERC-20 transfer logs and matches the payment request", () => {
    const amount = parseTokenAmount(baseRequest.amount, "USDC");
    const topics = encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: {
        from: sender,
        to: recipient
      }
    });
    const data = encodeAbiParameters([{ type: "uint256" }], [amount]);
    const log = {
      address: TOKENS.USDC.address,
      blockNumber: 701n,
      data,
      topics,
      transactionHash: `0x${"a".repeat(64)}`
    } as unknown as Log;

    const decoded = decodeTransferLog(log);
    expect(decoded).toBeDefined();
    expect(decoded?.from).toBe(sender);
    expect(decoded?.to).toBe(recipient);
    expect(decoded?.value).toBe(amount);
    expect(decoded && transferMatchesRequest(baseRequest, decoded)).toBe(true);
  });
});
