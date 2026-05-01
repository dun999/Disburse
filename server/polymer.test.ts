import { describe, expect, it } from "vitest";
import { decodePolymerProofToHex, queryPolymerProof } from "./polymer";

describe("Polymer proof decoding", () => {
  it("converts base64 proof bytes to hex calldata", () => {
    expect(decodePolymerProofToHex(Buffer.from([1, 2, 255, 16]).toString("base64"))).toBe("0x0102ff10");
  });

  it("rejects empty proof payloads", () => {
    expect(() => decodePolymerProofToHex("")).toThrow("empty");
  });

  it("queries Polymer proof jobs with numeric ids", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.POLYMER_TESTNET_API_KEY;
    const calls: unknown[] = [];
    process.env.POLYMER_TESTNET_API_KEY = "test-key";
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "pending" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    try {
      await queryPolymerProof(765549);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) {
        delete process.env.POLYMER_TESTNET_API_KEY;
      } else {
        process.env.POLYMER_TESTNET_API_KEY = originalApiKey;
      }
    }

    expect(calls).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "proof_query",
        params: [765549]
      }
    ]);
  });
});
