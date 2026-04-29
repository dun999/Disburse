import { describe, expect, it } from "vitest";
import { parseExportBundle } from "./storage";

const recipient = "0x1111111111111111111111111111111111111111";
const sender = "0x2222222222222222222222222222222222222222";
const txHash = `0x${"a".repeat(64)}`;

describe("ledger import recovery", () => {
  it("normalizes valid imported records and drops malformed entries", () => {
    const bundle = parseExportBundle(
      JSON.stringify({
        exportedAt: "2026-04-28T00:00:00.000Z",
        requests: [
          {
            id: "req_imported",
            recipient,
            token: "USDC",
            amount: "1.230000",
            label: "  Imported   invoice ",
            note: "  settled   by desk ",
            invoiceDate: "2026-04-29",
            expiresAt: "2026-04-28T00:15:00.000Z",
            submittedAt: "2026-04-28T00:03:00.000Z",
            createdAt: "2026-04-28T00:00:00.000Z",
            startBlock: "700",
            status: "mystery",
            txHash: "not-a-hash"
          },
          {
            id: "bad_request",
            token: "DOGE"
          }
        ],
        receipts: [
          {
            requestId: "req_imported",
            txHash,
            from: sender,
            to: recipient,
            token: "USDC",
            amount: "1.230000",
            blockNumber: "701",
            confirmedAt: "2026-04-28T00:01:00.000Z",
            explorerUrl: "https://example.invalid"
          },
          {
            requestId: "bad_receipt",
            txHash: "0x123",
            token: "USDC"
          }
        ]
      })
    );

    expect(bundle.requests).toHaveLength(1);
    expect(bundle.requests[0]).toMatchObject({
      id: "req_imported",
      amount: "1.23",
      label: "Imported invoice",
      note: "settled by desk",
      invoiceDate: "2026-04-29",
      expiresAt: "2026-04-28T00:15:00.000Z",
      submittedAt: "2026-04-28T00:03:00.000Z",
      status: "open",
      txHash: undefined
    });
    expect(bundle.receipts).toHaveLength(1);
    expect(bundle.receipts[0]).toMatchObject({
      requestId: "req_imported",
      txHash,
      amount: "1.23",
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`
    });
  });

  it("rejects files without request and receipt arrays", () => {
    expect(() => parseExportBundle(JSON.stringify({ requests: [] }))).toThrow("missing requests or receipts");
  });
});
