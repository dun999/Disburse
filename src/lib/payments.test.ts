import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import { erc20Abi, TOKENS } from "./arc";
import {
  buildShareUrl,
  decodeRequestPayload,
  decodeTransferLog,
  encodeRequestPayload,
  formatTokenAmount,
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
  createdAt: "2026-04-28T00:00:00.000Z",
  startBlock: "700",
  status: "open"
};

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
      startBlock: baseRequest.startBlock,
      status: "open"
    });
  });

  it("builds the /pay request URL", () => {
    expect(buildShareUrl(baseRequest, "https://desk.example")).toMatch(/^https:\/\/desk\.example\/pay\?r=/);
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
