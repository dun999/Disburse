import { encodeAbiParameters, encodeEventTopics, type Hash } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  ARC_DESTINATION_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  qrPaymentSourceAbi,
  requestIdToBytes32
} from "./crosschain";
import { submitCrossChainPayment } from "./crosschainOnchain";
import type { EthereumProvider } from "./onchain";
import type { PaymentRequest } from "./payments";

const fakeClient = vi.hoisted(() => ({
  getTransactionCount: vi.fn(),
  readContract: vi.fn(),
  waitForTransactionReceipt: vi.fn()
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => fakeClient)
  };
});

vi.mock("./crosschainConfig", () => ({
  requireCrossChainBrowserRoute: () => ({
    chainId: 84_532,
    sourceContract: "0x8c535227ed2b2963a3c1176510bc59e7a7fef07d",
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
  })
}));

const account = "0xedc2e82b99267060adea22ebda307a23497a7e5e";
const recipient = "0x3d6a8babf5e08103B8DAF66A8608F13B761017ad";
const sourceContract = "0x8c535227ed2b2963a3c1176510bc59e7a7fef07d";
const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const approvalHash = "0x52d86d0423300c9bf1a7dd76e30079bdceba0d233c527e7d15602191651f1273" as Hash;
const paymentHash = "0xc71bbcf8d3f612b8d02b3401fb360399a32eddfc7f49a044ca79eeee4b0f1038" as Hash;

const request: PaymentRequest = {
  id: "45d87251-9b45-4652-9196-e30814926749",
  recipient,
  token: "USDC",
  amount: "1",
  label: "Test",
  note: "1",
  invoiceDate: "2026-05-01",
  expiresAt: "2026-05-01T06:25:35.435+00:00",
  createdAt: "2026-05-01T06:10:35.435+00:00",
  startBlock: "0",
  status: "open",
  destinationChainId: ARC_DESTINATION_CHAIN_ID,
  allowedSourceChainIds: [ARC_DESTINATION_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID]
};

describe("cross-chain wallet submission flow", () => {
  it("returns and persists only the QR pay hash after an approval hash", async () => {
    let allowanceReads = 0;
    fakeClient.readContract.mockImplementation(async () => {
      allowanceReads += 1;
      return allowanceReads === 1 ? 0n : 1_000_000n;
    });
    fakeClient.getTransactionCount.mockResolvedValue(7);
    fakeClient.waitForTransactionReceipt.mockImplementation(async ({ hash }: { hash: Hash }) =>
      hash === approvalHash
        ? { status: "success", to: token, logs: [] }
        : {
            status: "success",
            to: sourceContract,
            logs: [paymentLog()]
          }
    );

    const sentTransactions: Array<{ to: string }> = [];
    const provider = {
      request: vi.fn(async ({ method, params }) => {
        if (method === "eth_chainId") {
          return `0x${BASE_SEPOLIA_CHAIN_ID.toString(16)}`;
        }
        if (method === "eth_sendTransaction") {
          sentTransactions.push(params?.[0] as { to: string });
          return sentTransactions.length === 1 ? approvalHash : paymentHash;
        }
        throw new Error(`Unexpected provider method ${method}`);
      })
    } as unknown as EthereumProvider;
    const onApprovalSubmitted = vi.fn();

    const result = await submitCrossChainPayment(provider, account, request, BASE_SEPOLIA_CHAIN_ID, {
      onApprovalSubmitted
    });

    expect(result).toBe(paymentHash);
    expect(onApprovalSubmitted).toHaveBeenCalledWith(approvalHash);
    expect(sentTransactions.map((transaction) => transaction.to.toLowerCase())).toEqual([
      token.toLowerCase(),
      sourceContract.toLowerCase()
    ]);
  });
});

function paymentLog() {
  const topics = encodeEventTopics({
    abi: qrPaymentSourceAbi,
    eventName: "QrPaymentInitiated",
    args: {
      requestId: requestIdToBytes32(request.id),
      payer: account,
      recipient
    }
  });

  return {
    address: sourceContract,
    data: encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" }
      ],
      [token, 1_000_000n, BigInt(ARC_DESTINATION_CHAIN_ID), 53078263711003308537863127631969146500144083446391995903662680801156698615067n]
    ),
    topics
  };
}
