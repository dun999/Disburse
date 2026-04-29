import { describe, expect, it } from "vitest";
import { parseGwei } from "viem";
import { ARC_CHAIN_ID, ARC_MIN_GAS_PRICE, ARC_RPC_ENDPOINTS, arcTestnet, TOKENS } from "./arc";

describe("Arc network configuration", () => {
  it("pins Disburse to Arc Testnet with published failover endpoints", () => {
    expect(ARC_CHAIN_ID).toBe(5_042_002);
    expect(arcTestnet.id).toBe(ARC_CHAIN_ID);
    expect(ARC_RPC_ENDPOINTS).toHaveLength(4);
    expect(new Set(ARC_RPC_ENDPOINTS.map((endpoint) => endpoint.id)).size).toBe(ARC_RPC_ENDPOINTS.length);
    expect(arcTestnet.rpcUrls.default.http).toEqual(ARC_RPC_ENDPOINTS.map((endpoint) => endpoint.url));
  });

  it("keeps stablecoin and gas metadata aligned with Arc docs", () => {
    expect(arcTestnet.nativeCurrency).toMatchObject({
      name: "USDC",
      symbol: "USDC",
      decimals: 18
    });
    expect(ARC_MIN_GAS_PRICE).toBe(parseGwei("20"));
    expect(TOKENS.USDC).toMatchObject({
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6
    });
    expect(TOKENS.EURC).toMatchObject({
      address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
      decimals: 6
    });
  });
});
