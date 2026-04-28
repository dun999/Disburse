import { describe, expect, it } from "vitest";
import { errorToMessage, isTxPoolFullError } from "./errors";

describe("error messages", () => {
  it("turns txpool saturation into an actionable payment message", () => {
    const error = {
      shortMessage: 'The contract function "transfer" reverted with the following reason: txpool is full'
    };

    expect(isTxPoolFullError(error)).toBe(true);
    expect(errorToMessage(error)).toBe(
      "Arc Testnet transaction pool is full right now. No transaction hash was returned; wait a minute, then retry Pay request."
    );
  });

  it("falls back to the preferred provider message", () => {
    expect(errorToMessage({ shortMessage: "User rejected the request.", message: "details" })).toBe(
      "User rejected the request."
    );
  });
});
