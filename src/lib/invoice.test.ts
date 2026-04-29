import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildInvoiceFilename, formatInvoiceDate, generateInvoicePdf } from "./invoice";
import { validateRecipient, type PaymentRequest, type Receipt } from "./payments";

const request: PaymentRequest = {
  id: "req_invoice_002",
  recipient: validateRecipient("0x1111111111111111111111111111111111111111"),
  token: "USDC",
  amount: "10",
  label: "Invoice 2",
  note: "Food and Drink",
  invoiceDate: "2026-04-29",
  expiresAt: "2026-04-29T10:15:00.000Z",
  createdAt: "2026-04-29T10:00:00.000Z",
  startBlock: "700",
  status: "paid",
  txHash: `0x${"a".repeat(64)}`
};

const receipt: Receipt = {
  requestId: request.id,
  txHash: `0x${"a".repeat(64)}`,
  from: validateRecipient("0x2222222222222222222222222222222222222222"),
  to: request.recipient,
  token: "USDC",
  amount: "10",
  blockNumber: "701",
  confirmedAt: "2026-04-29T10:03:00.000Z",
  explorerUrl: `https://testnet.arcscan.app/tx/0x${"a".repeat(64)}`
};

describe("invoice PDFs", () => {
  it("generates a valid PDF with QR payment metadata", async () => {
    const bytes = await generateInvoicePdf({ request, receipt });
    const header = new TextDecoder().decode(bytes.slice(0, 5));
    expect(header).toBe("%PDF-");

    const document = await PDFDocument.load(bytes);
    expect(document.getTitle()).toBe("Disburse invoice req_invoice_002");
    expect(document.getSubject()).toBe("Invoice 2 - 10 USDC");
    const keywords = document.getKeywords();
    expect(keywords).toContain(receipt.txHash);
    expect(keywords).toContain("Invoice 2");
    expect(keywords).toContain("04/29/26");
  });

  it("formats invoice dates and filenames", () => {
    expect(formatInvoiceDate("2026-04-29")).toBe("04/29/26");
    expect(buildInvoiceFilename({ request, receipt })).toBe("disburse-invoice-invoice-2-aaaaaaaa.pdf");
  });
});
