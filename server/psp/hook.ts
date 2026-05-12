/**
 * PSP — Feature-flagged issuance hook
 *
 * Called after a payment reaches terminal "paid" state. Non-fatal:
 * any failure is logged but never propagated to the payment flow.
 *
 * Gated on: process.env.ENABLE_PSP === "1"
 */

import type { PaymentRequest, Receipt } from "../../src/lib/payments.js";
import { issuePsp } from "./issue.js";

/**
 * Attempt to issue a PSP. Silently returns if:
 * - The feature flag is off
 * - The signing key is not configured
 * - Any error occurs during issuance
 */
export async function tryIssuePsp(
  request: PaymentRequest,
  receipt: Receipt
): Promise<void> {
  if (process.env.ENABLE_PSP !== "1") {
    return;
  }

  if (!process.env.DISBURSE_PSP_SIGNING_KEY) {
    return;
  }

  try {
    await issuePsp(request, receipt);
  } catch (error) {
    // Non-fatal — log and continue
    console.error(
      `[PSP] Failed to issue PSP for request ${request.id}:`,
      error instanceof Error ? error.message : error
    );
  }
}
