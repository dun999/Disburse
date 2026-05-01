import { encodeAbiParameters, encodeEventTopics, type Log, type TransactionReceipt } from "viem";
import { describe, expect, it } from "vitest";
import {
  ARC_DESTINATION_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  qrPaymentSourceAbi,
  requestIdToBytes32
} from "../src/lib/crosschain";
import { parseTokenAmount, type PaymentRequest } from "../src/lib/payments";
import { resolveSourcePaymentLog } from "./crosschain";

const payer = "0x2222222222222222222222222222222222222222";
const recipient = "0x1111111111111111111111111111111111111111";
const token = "0x3333333333333333333333333333333333333333";
const sourceContract = "0x4444444444444444444444444444444444444444";

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
