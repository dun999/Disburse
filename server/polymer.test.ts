import { describe, expect, it } from "vitest";
import { decodePolymerProofToHex } from "./polymer";

describe("Polymer proof decoding", () => {
  it("converts base64 proof bytes to hex calldata", () => {
    expect(decodePolymerProofToHex(Buffer.from([1, 2, 255, 16]).toString("base64"))).toBe("0x0102ff10");
  });

  it("rejects empty proof payloads", () => {
    expect(() => decodePolymerProofToHex("")).toThrow("empty");
  });
});
