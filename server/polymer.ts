import type { Hex } from "viem";

export const POLYMER_TESTNET_ENDPOINT =
  process.env.POLYMER_TESTNET_ENDPOINT?.trim() || "https://api.testnet.polymer.zone/v1/";

export type PolymerProofRequest = {
  srcChainId: number;
  srcBlockNumber: bigint | number | string;
  globalLogIndex: number;
};

export type PolymerProofResult =
  | { status: "complete" | "completed"; proof: string }
  | { status: "pending" }
  | { status: "error"; failureReason?: string };

type PolymerJsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: {
    code: number | string;
    message: string;
  };
};

export async function requestPolymerProof(input: PolymerProofRequest): Promise<string> {
  const result = await polymerRpc<number | string>("proof_request", [
    {
      srcChainId: input.srcChainId,
      srcBlockNumber: Number(input.srcBlockNumber),
      globalLogIndex: input.globalLogIndex
    }
  ]);
  return String(result);
}

export async function queryPolymerProof(jobId: string): Promise<PolymerProofResult> {
  return polymerRpc<PolymerProofResult>("proof_query", [jobId]);
}

export async function pollPolymerProof(jobId: string, options: { attempts?: number; intervalMs?: number } = {}): Promise<Hex> {
  const attempts = options.attempts ?? 15;
  const intervalMs = options.intervalMs ?? 2_000;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await queryPolymerProof(jobId);
    if ((result.status === "complete" || result.status === "completed") && result.proof) {
      return decodePolymerProofToHex(result.proof);
    }
    if (result.status === "error") {
      throw new Error(result.failureReason || "Polymer proof generation failed.");
    }
    await delay(intervalMs);
  }

  throw new Error("Polymer proof generation timed out.");
}

export function decodePolymerProofToHex(proof: string): Hex {
  const normalized = proof.trim();
  if (!normalized) {
    throw new Error("Polymer proof is empty.");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.byteLength) {
    throw new Error("Polymer proof decoded to empty bytes.");
  }
  return `0x${bytes.toString("hex")}` as Hex;
}

async function polymerRpc<T>(method: string, params: unknown[]): Promise<T> {
  const apiKey = process.env.POLYMER_TESTNET_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error("POLYMER_TESTNET_API_KEY is not configured.");
  }

  const response = await fetch(POLYMER_TESTNET_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });
  const body = (await response.json()) as PolymerJsonRpcResponse<T>;

  if (!response.ok || body.error) {
    throw new Error(body.error?.message || `Polymer ${method} failed with HTTP ${response.status}.`);
  }
  if (body.result === undefined) {
    throw new Error(`Polymer ${method} did not return a result.`);
  }
  return body.result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
