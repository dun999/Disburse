import { encodeAbiParameters, encodeEventTopics, type Log, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import {
  ARC_DESTINATION_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  qrPaymentSourceAbi,
  requestIdToBytes32
} from "../src/lib/crosschain";
import { parseTokenAmount, type PaymentRequest } from "../src/lib/payments";
import { readServerRouteConfigForTest, resolveSourcePaymentLog } from "./crosschain";

const payer = "0x2222222222222222222222222222222222222222";
const recipient = "0x1111111111111111111111111111111111111111";
const token = "0x3333333333333333333333333333333333333333";
const sourceContract = "0x4444444444444444444444444444444444444444";
const livePayer = "0xedc2e82b99267060adea22ebda307a23497a7e5e";
const liveRecipient = "0x3d6a8babf5e08103B8DAF66A8608F13B761017ad";
const liveBaseUsdc = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const liveSourceContract = "0x8c535227ed2b2963a3c1176510bc59e7a7fef07d";
const livePayHash = "0xc71bbcf8d3f612b8d02b3401fb360399a32eddfc7f49a044ca79eeee4b0f1038";
const liveApprovalHash = "0x52d86d0423300c9bf1a7dd76e30079bdceba0d233c527e7d15602191651f1273";

const request: PaymentRequest = {
  id: "7e7b5b2f-9df1-4ea1-a0da-0889fb6bd4fd",
  recipient,
  token: "USDC",
  amount: "12.34",
  label: "Cross-chain invoice",
  createdAt: "2026-04-30T00:00:00.000Z",
  expiresAt: "2026-04-30T00:15:00.000Z",
  startBlock: "0",
  status: "open",
  destinationChainId: ARC_DESTINATION_CHAIN_ID,
  allowedSourceChainIds: [BASE_SEPOLIA_CHAIN_ID]
};

const liveRequest: PaymentRequest = {
  id: "45d87251-9b45-4652-9196-e30814926749",
  recipient: liveRecipient,
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

describe("cross-chain source payment resolution", () => {
  it("extracts the Polymer proof coordinates from the source event", () => {
    const source = resolveSourcePaymentLog(request, receiptWithLog(paymentLog()), {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      sourceContract,
      tokenAddress: token
    });

    expect(source).toMatchObject({
      sourceChainId: BASE_SEPOLIA_CHAIN_ID,
      sourceBlockNumber: "1234",
      sourceLogIndex: 7,
      payer,
      recipient,
      sourceToken: token,
      destinationChainId: ARC_DESTINATION_CHAIN_ID
    });
  });

  it("rejects source events with mismatched payment amounts", () => {
    expect(() =>
      resolveSourcePaymentLog(request, receiptWithLog(paymentLog(parseTokenAmount("1", "USDC"))), {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        sourceContract,
        tokenAddress: token
      })
    ).toThrow("expected cross-chain payment event");
  });

  it("accepts the live Base QR pay transaction for the reported request", () => {
    const source = resolveSourcePaymentLog(liveRequest, livePayReceipt(), {
      chainId: BASE_SEPOLIA_CHAIN_ID,
      sourceContract: liveSourceContract,
      tokenAddress: liveBaseUsdc
    });

    expect(source).toMatchObject({
      sourceChainId: BASE_SEPOLIA_CHAIN_ID,
      sourceTxHash: livePayHash,
      sourceBlockNumber: "40923806",
      sourceLogIndex: 1,
      amount: 1_000_000n,
      destinationChainId: ARC_DESTINATION_CHAIN_ID
    });
    expect(source.payer.toLowerCase()).toBe(livePayer);
    expect(source.recipient.toLowerCase()).toBe(liveRecipient.toLowerCase());
    expect(source.sourceToken.toLowerCase()).toBe(liveBaseUsdc.toLowerCase());
  });

  it("rejects the companion USDC approval hash as non-payable", () => {
    expect(() =>
      resolveSourcePaymentLog(liveRequest, liveApprovalReceipt(), {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        sourceContract: liveSourceContract,
        tokenAddress: liveBaseUsdc
      })
    ).toThrow(
      "The submitted transaction is a USDC token transaction, not the QR pay transaction. Submit or verify the hash from the wallet transaction that calls pay on the QR payment contract."
    );
  });

  it("falls back to the deployed token when production env points USDC at the source contract", () => {
    const previousToken = process.env.BASE_SEPOLIA_USDC_ADDRESS;
    const previousSource = process.env.BASE_SEPOLIA_QR_PAYMENT_SOURCE;
    const previousViteSource = process.env.VITE_BASE_SEPOLIA_QR_PAYMENT_SOURCE;
    try {
      process.env.BASE_SEPOLIA_USDC_ADDRESS = liveSourceContract;
      delete process.env.BASE_SEPOLIA_QR_PAYMENT_SOURCE;
      process.env.VITE_BASE_SEPOLIA_QR_PAYMENT_SOURCE = liveSourceContract;

      const config = readServerRouteConfigForTest(BASE_SEPOLIA_CHAIN_ID, "source");

      expect(config.sourceContract.toLowerCase()).toBe(liveSourceContract);
      expect(config.tokenAddress.toLowerCase()).toBe(liveBaseUsdc.toLowerCase());
    } finally {
      restoreEnv("BASE_SEPOLIA_USDC_ADDRESS", previousToken);
      restoreEnv("BASE_SEPOLIA_QR_PAYMENT_SOURCE", previousSource);
      restoreEnv("VITE_BASE_SEPOLIA_QR_PAYMENT_SOURCE", previousViteSource);
    }
  });
});

function receiptWithLog(log: Log): TransactionReceipt {
  return {
    transactionHash: `0x${"a".repeat(64)}`,
    blockHash: `0x${"b".repeat(64)}`,
    blockNumber: 1234n,
    contractAddress: null,
    cumulativeGasUsed: 1n,
    effectiveGasPrice: 1n,
    from: payer,
    gasUsed: 1n,
    logs: [log],
    logsBloom: `0x${"0".repeat(512)}`,
    status: "success",
    to: sourceContract,
    transactionIndex: 0,
    type: "eip1559"
  } as TransactionReceipt;
}

function paymentLog(amount = parseTokenAmount("12.34", "USDC")): Log {
  const topics = encodeEventTopics({
    abi: qrPaymentSourceAbi,
    eventName: "QrPaymentInitiated",
    args: {
      requestId: requestIdToBytes32(request.id),
      payer,
      recipient
    }
  });
  const data = encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" }
    ],
    [token, amount, BigInt(ARC_DESTINATION_CHAIN_ID), 99n]
  );

  return {
    address: sourceContract,
    blockNumber: 1234n,
    blockHash: `0x${"b".repeat(64)}`,
    data,
    logIndex: 7,
    removed: false,
    topics,
    transactionIndex: 0,
    transactionHash: `0x${"a".repeat(64)}`
  } as unknown as Log;
}

function livePayReceipt(): TransactionReceipt {
  return {
    transactionHash: livePayHash,
    blockHash: "0x40a2fb0e3086de6dc40f1e32d86528e56ef0c1766fcec59ea5a1fe2b301464a7",
    blockNumber: 40_923_806n,
    contractAddress: null,
    cumulativeGasUsed: 122_886n,
    effectiveGasPrice: 6_000_000n,
    from: livePayer,
    gasUsed: 76_692n,
    logs: [
      {
        address: liveBaseUsdc,
        blockNumber: 40_923_806n,
        blockHash: "0x40a2fb0e3086de6dc40f1e32d86528e56ef0c1766fcec59ea5a1fe2b301464a7",
        data: "0x00000000000000000000000000000000000000000000000000000000000f4240",
        logIndex: 0,
        removed: false,
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x000000000000000000000000edc2e82b99267060adea22ebda307a23497a7e5e",
          "0x0000000000000000000000008c535227ed2b2963a3c1176510bc59e7a7fef07d"
        ],
        transactionHash: livePayHash,
        transactionIndex: 1
      },
      {
        address: liveSourceContract,
        blockNumber: 40_923_806n,
        blockHash: "0x40a2fb0e3086de6dc40f1e32d86528e56ef0c1766fcec59ea5a1fe2b301464a7",
        data: "0x000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e00000000000000000000000000000000000000000000000000000000000f424000000000000000000000000000000000000000000000000000000000004cef5275593b8e3f22c4dd8452055924cbdf9365455d326ede24d045698c8b41aa2d1b",
        logIndex: 1,
        removed: false,
        topics: [
          "0xe8f3721c818b94987102a1f1d5b7511c6dbc94681f94564749d1538be26ec799",
          "0x80a9086d764fb85e61e1ecf6a1f721f40e46d6c97ac087d569ccc342d342615e",
          "0x000000000000000000000000edc2e82b99267060adea22ebda307a23497a7e5e",
          "0x0000000000000000000000003d6a8babf5e08103b8daf66a8608f13b761017ad"
        ],
        transactionHash: livePayHash,
        transactionIndex: 1
      }
    ],
    logsBloom: `0x${"0".repeat(512)}`,
    status: "success",
    to: liveSourceContract,
    transactionIndex: 1,
    type: "legacy"
  } as TransactionReceipt;
}

function liveApprovalReceipt(): TransactionReceipt {
  return {
    transactionHash: liveApprovalHash,
    blockHash: "0x063be7316cad3ccc7192f59f096fad2572e1fa5b83fd7c0822e6f3502c46bbb6",
    blockNumber: 40_923_802n,
    contractAddress: null,
    cumulativeGasUsed: 148_523n,
    effectiveGasPrice: 6_000_000n,
    from: livePayer,
    gasUsed: 55_437n,
    logs: [
      {
        address: liveBaseUsdc,
        blockNumber: 40_923_802n,
        blockHash: "0x063be7316cad3ccc7192f59f096fad2572e1fa5b83fd7c0822e6f3502c46bbb6",
        data: "0x00000000000000000000000000000000000000000000000000000000000f4240",
        logIndex: 1,
        removed: false,
        topics: [
          "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
          "0x000000000000000000000000edc2e82b99267060adea22ebda307a23497a7e5e",
          "0x0000000000000000000000008c535227ed2b2963a3c1176510bc59e7a7fef07d"
        ],
        transactionHash: liveApprovalHash,
        transactionIndex: 2
      }
    ],
    logsBloom: `0x${"0".repeat(512)}`,
    status: "success",
    to: liveBaseUsdc,
    transactionIndex: 2,
    type: "legacy"
  } as TransactionReceipt;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
