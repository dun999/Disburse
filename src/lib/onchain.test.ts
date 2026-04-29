import { describe, expect, it } from "vitest";
import { parseGwei, type Address } from "viem";
import { ARC_MIN_GAS_PRICE } from "./arc";
import {
  applyArcGasFloor,
  buildLogBlockRanges,
  resolveTransferVerification,
  selectActiveRpcEndpoint,
  type RpcEndpointStatus
} from "./onchain";
import type { DecodedTransfer, PaymentRequest } from "./payments";

const recipient = "0x1111111111111111111111111111111111111111" as Address;
const sender = "0x2222222222222222222222222222222222222222" as Address;

const baseRequest: PaymentRequest = {
  id: "req_reliability_001",
  recipient,
  token: "USDC",
  amount: "12.34",
  label: "Invoice 7421",
  createdAt: "2026-04-28T00:00:00.000Z",
  startBlock: "700",
  status: "open"
};

function transfer(value: bigint, blockNumber: bigint, suffix: string): DecodedTransfer {
  return {
    txHash: `0x${suffix.repeat(64)}` as `0x${string}`,
    blockNumber,
    from: sender,
    to: recipient,
    value
  };
}

describe("Arc gas policy", () => {
  it("enforces the documented 20 gwei minimum gas price", () => {
    expect(applyArcGasFloor(parseGwei("1"))).toBe(ARC_MIN_GAS_PRICE);
    expect(applyArcGasFloor(parseGwei("20"))).toBe(ARC_MIN_GAS_PRICE);
    expect(applyArcGasFloor(parseGwei("25"))).toBe(parseGwei("25"));
  });
});

describe("Arc log scan windows", () => {
  it("splits scans into 10,000 block windows by default", () => {
    expect(buildLogBlockRanges(100n, 20_100n)).toEqual([
      { fromBlock: 100n, toBlock: 10_099n },
      { fromBlock: 10_100n, toBlock: 20_099n },
      { fromBlock: 20_100n, toBlock: 20_100n }
    ]);
  });

  it("returns no ranges when the request starts after the latest block", () => {
    expect(buildLogBlockRanges(900n, 899n)).toEqual([]);
  });
});

describe("transfer verification resolution", () => {
  it("prioritizes an exact transfer over a newer possible match", () => {
    const result = resolveTransferVerification(baseRequest, [
      transfer(5_000_000n, 701n, "a"),
      transfer(12_340_000n, 702n, "b"),
      transfer(9_000_000n, 703n, "c")
    ]);

    expect(result.status).toBe("paid");
    expect(result.status === "paid" ? result.receipt.txHash : undefined).toBe(`0x${"b".repeat(64)}`);
  });

  it("returns the latest transfer as a possible match when amount differs", () => {
    const result = resolveTransferVerification(baseRequest, [
      transfer(5_000_000n, 701n, "a"),
      transfer(9_000_000n, 703n, "c")
    ]);

    expect(result.status).toBe("possible_match");
    expect(result.status === "possible_match" ? result.transfer.txHash : undefined).toBe(`0x${"c".repeat(64)}`);
  });
});

describe("RPC endpoint selection", () => {
  it("selects the healthiest endpoint by freshest block, then latency", () => {
    const statuses: RpcEndpointStatus[] = [
      {
        id: "public",
        label: "Arc public",
        url: "https://rpc.testnet.arc.network",
        host: "rpc.testnet.arc.network",
        healthy: true,
        blockNumber: "100",
        latencyMs: 30
      },
      {
        id: "drpc",
        label: "dRPC",
        url: "https://rpc.drpc.testnet.arc.network",
        host: "rpc.drpc.testnet.arc.network",
        healthy: true,
        blockNumber: "101",
        latencyMs: 90
      },
      {
        id: "quicknode",
        label: "QuickNode",
        url: "https://rpc.quicknode.testnet.arc.network",
        host: "rpc.quicknode.testnet.arc.network",
        healthy: false
      }
    ];

    expect(selectActiveRpcEndpoint(statuses)?.id).toBe("drpc");

    statuses[0].blockNumber = "101";
    expect(selectActiveRpcEndpoint(statuses)?.id).toBe("public");
  });
});
