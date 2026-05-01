import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type TransactionReceipt
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TOKENS } from "../src/lib/arc.js";
import {
  ARC_DESTINATION_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  CROSSCHAIN_CHAINS,
  getCrossChainExplorerTxUrl,
  getAllowedSourceChainIds,
  isRemotePaymentSourceChainId,
  qrPaymentInitiatedEvent,
  qrPaymentSettlementAbi,
  requestIdToBytes32,
  type RemotePaymentSourceChainId,
  type CrossChainPaymentState
} from "../src/lib/crosschain.js";
import {
  isCrossChainPaymentRequest,
  makeCrossChainReceipt,
  parseTokenAmount,
  type PaymentRequest,
  type Receipt
} from "../src/lib/payments.js";
import { HttpError } from "./http.js";
import { pollPolymerProof, requestPolymerProof } from "./polymer.js";

export type CrossChainSourcePayment = {
  sourceChainId: RemotePaymentSourceChainId;
  sourceTxHash: Hash;
  sourceBlockNumber: string;
  sourceLogIndex: number;
  payer: Address;
  recipient: Address;
  sourceToken: Address;
  amount: bigint;
  destinationChainId: typeof ARC_DESTINATION_CHAIN_ID;
  nonce: bigint;
};

export type CrossChainSettlementResult = {
  receipt: Receipt;
  settlement: CrossChainPaymentState;
};

type ServerRouteConfig = {
  chainId: RemotePaymentSourceChainId | typeof ARC_DESTINATION_CHAIN_ID;
  rpcUrl: string;
  sourceContract?: Address;
  settlementContract?: Address;
  tokenAddress: Address;
  relayerPrivateKey?: Hex;
};

export async function resolveCrossChainSourcePayment(
  request: PaymentRequest,
  txHash: Hash,
  sourceChainIdInput: unknown
): Promise<CrossChainSourcePayment> {
  if (!isCrossChainPaymentRequest(request)) {
    throw new HttpError(400, "Payment request is not an Arc-settlement QR.");
  }
  if (!isRemotePaymentSourceChainId(sourceChainIdInput)) {
    throw new HttpError(400, "Choose a supported source chain.");
  }
  if (!request.allowedSourceChainIds?.includes(sourceChainIdInput)) {
    throw new HttpError(400, "This source chain is not allowed for the QR request.");
  }

  const config = readServerRouteConfig(sourceChainIdInput, "source");
  const receipt = await readSourceReceipt(config, txHash);
  if (receipt.status === "reverted") {
    throw new HttpError(409, "The submitted source-chain transaction reverted.");
  }

  return resolveSourcePaymentLog(request, receipt, {
    chainId: sourceChainIdInput,
    sourceContract: requireSourceContract(config),
    tokenAddress: config.tokenAddress
  });
}

export function resolveSourcePaymentLog(
  request: PaymentRequest,
  receipt: TransactionReceipt,
  config: {
    chainId: RemotePaymentSourceChainId;
    sourceContract: Address;
    tokenAddress: Address;
  }
): CrossChainSourcePayment {
  if (!isCrossChainPaymentRequest(request)) {
    throw new Error("Payment request is not an Arc-settlement QR.");
  }

  const expectedRequestId = requestIdToBytes32(request.id).toLowerCase();
  const expectedAmount = parseTokenAmount(request.amount, request.token);
  const matchingLog = receipt.logs
    .filter((log) => log.address.toLowerCase() === config.sourceContract?.toLowerCase())
    .map((log) => decodeSourcePaymentLog(log))
    .find((decoded) => {
      if (!decoded) {
        return false;
      }
      return (
        decoded.requestId.toLowerCase() === expectedRequestId &&
        decoded.recipient.toLowerCase() === request.recipient.toLowerCase() &&
        decoded.token.toLowerCase() === config.tokenAddress.toLowerCase() &&
        decoded.amount === expectedAmount &&
        decoded.destinationChainId === BigInt(request.destinationChainId)
      );
    });

  if (!matchingLog) {
    throw new HttpError(409, "The submitted transaction did not emit the expected cross-chain payment event.");
  }
  if (matchingLog.logIndex === undefined) {
    throw new HttpError(409, "The source payment log is missing its global log index.");
  }

  return {
    sourceChainId: config.chainId,
    sourceTxHash: receipt.transactionHash,
    sourceBlockNumber: receipt.blockNumber.toString(),
    sourceLogIndex: matchingLog.logIndex,
    payer: matchingLog.payer,
    recipient: matchingLog.recipient,
    sourceToken: matchingLog.token,
    amount: matchingLog.amount,
    destinationChainId: request.destinationChainId,
    nonce: matchingLog.nonce
  };
}

export async function relayCrossChainSettlement(
  request: PaymentRequest,
  sourcePayment: CrossChainSourcePayment
): Promise<CrossChainSettlementResult> {
  if (!isCrossChainPaymentRequest(request)) {
    throw new HttpError(400, "Payment request is not an Arc-settlement QR.");
  }

  const destinationConfig = readServerRouteConfig(ARC_DESTINATION_CHAIN_ID, "destination");
  const proofJobId = await requestPolymerProof({
    srcChainId: sourcePayment.sourceChainId,
    srcBlockNumber: sourcePayment.sourceBlockNumber,
    globalLogIndex: sourcePayment.sourceLogIndex
  });
  const proof = await pollPolymerProof(proofJobId);
  const destinationReceipt = await submitSettlement(destinationConfig, proof);

  return {
    receipt: makeCrossChainReceipt({
      request,
      destinationTxHash: destinationReceipt.transactionHash,
      payer: sourcePayment.payer,
      blockNumber: destinationReceipt.blockNumber.toString(),
      explorerUrl: getCrossChainExplorerTxUrl(ARC_DESTINATION_CHAIN_ID, destinationReceipt.transactionHash),
      sourceChainId: sourcePayment.sourceChainId,
      sourceTxHash: sourcePayment.sourceTxHash
    }),
    settlement: {
      destinationChainId: ARC_DESTINATION_CHAIN_ID,
      sourceChainId: sourcePayment.sourceChainId,
      sourceTxHash: sourcePayment.sourceTxHash,
      sourceBlockNumber: sourcePayment.sourceBlockNumber,
      sourceLogIndex: sourcePayment.sourceLogIndex,
      proofJobId,
      destinationTxHash: destinationReceipt.transactionHash,
      destinationBlockNumber: destinationReceipt.blockNumber.toString(),
      stage: "settled"
    }
  };
}

export function readCreateCrossChainInput(input: Record<string, unknown>): {
  destinationChainId: typeof ARC_DESTINATION_CHAIN_ID;
  allowedSourceChainIds: ReturnType<typeof getAllowedSourceChainIds>;
} {
  return {
    destinationChainId: ARC_DESTINATION_CHAIN_ID,
    allowedSourceChainIds: getAllowedSourceChainIds()
  };
}

function decodeSourcePaymentLog(log: Log) {
  try {
    const decoded = decodeEventLog({
      abi: [qrPaymentInitiatedEvent],
      data: log.data,
      topics: log.topics
    });
    if (decoded.eventName !== "QrPaymentInitiated") {
      return undefined;
    }
    const args = decoded.args as {
      requestId: Hex;
      payer: Address;
      recipient: Address;
      token: Address;
      amount: bigint;
      destinationChainId: bigint;
      nonce: bigint;
    };
    return {
      requestId: args.requestId,
      payer: getAddress(args.payer),
      recipient: getAddress(args.recipient),
      token: getAddress(args.token),
      amount: args.amount,
      destinationChainId: args.destinationChainId,
      nonce: args.nonce,
      logIndex: typeof log.logIndex === "number" ? log.logIndex : undefined
    };
  } catch {
    return undefined;
  }
}

async function readSourceReceipt(config: ServerRouteConfig, txHash: Hash): Promise<TransactionReceipt> {
  try {
    return await createServerPublicClient(config).getTransactionReceipt({ hash: txHash });
  } catch {
    throw new HttpError(409, "Source-chain transaction receipt is not available yet.");
  }
}

async function submitSettlement(config: ServerRouteConfig, proof: Hex): Promise<TransactionReceipt> {
  if (!config.relayerPrivateKey) {
    throw new Error(`Relayer private key for ${CROSSCHAIN_CHAINS[config.chainId].label} is not configured.`);
  }

  const account = privateKeyToAccount(config.relayerPrivateKey);
  const publicClient = createServerPublicClient(config);
  const walletClient = createWalletClient({
    account,
    chain: CROSSCHAIN_CHAINS[config.chainId].chain,
    transport: http(config.rpcUrl, {
      timeout: 15_000
    })
  });
  const hash = await walletClient.writeContract({
    address: requireSettlementContract(config),
    abi: qrPaymentSettlementAbi,
    functionName: "settle",
    args: [proof]
  });

  return publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1
  });
}

function requireSettlementContract(config: ServerRouteConfig): Address {
  if (!config.settlementContract) {
    throw new Error(`Settlement contract for ${CROSSCHAIN_CHAINS[config.chainId].label} is not configured.`);
  }
  return config.settlementContract;
}

function requireSourceContract(config: ServerRouteConfig): Address {
  if (!config.sourceContract) {
    throw new Error(`Source contract for ${CROSSCHAIN_CHAINS[config.chainId].label} is not configured.`);
  }
  return config.sourceContract;
}

function createServerPublicClient(config: ServerRouteConfig) {
  return createPublicClient({
    chain: CROSSCHAIN_CHAINS[config.chainId].chain,
    transport: http(config.rpcUrl, {
      timeout: 10_000
    })
  });
}

function readServerRouteConfig(
  chainId: RemotePaymentSourceChainId | typeof ARC_DESTINATION_CHAIN_ID,
  use: "source" | "destination"
): ServerRouteConfig {
  const prefix =
    chainId === ARC_DESTINATION_CHAIN_ID ? "ARC" : chainId === BASE_SEPOLIA_CHAIN_ID ? "BASE_SEPOLIA" : "MEGAETH";
  const tokenAddress =
    readAddress(`${prefix}_USDC_ADDRESS`) ??
    readAddress(`VITE_${prefix}_USDC_ADDRESS`) ??
    (chainId === ARC_DESTINATION_CHAIN_ID ? TOKENS.USDC.address : undefined);
  const sourceContract =
    use === "source" ? readAddress(`${prefix}_QR_PAYMENT_SOURCE`) ?? readAddress(`VITE_${prefix}_QR_PAYMENT_SOURCE`) : undefined;
  const settlementContract =
    use === "destination"
      ? readAddress(`${prefix}_QR_PAYMENT_SETTLEMENT`) ?? readAddress(`VITE_${prefix}_QR_PAYMENT_SETTLEMENT`)
      : undefined;

  const missing = [];
  if (!tokenAddress) {
    missing.push("USDC token address");
  }
  if (use === "source" && !sourceContract) {
    missing.push("source contract");
  }
  if (use === "destination" && !settlementContract) {
    missing.push("settlement contract");
  }
  if (missing.length) {
    throw new Error(`Cross-chain ${use} route for ${CROSSCHAIN_CHAINS[chainId].label} is missing ${missing.join(", ")}.`);
  }

  return {
    chainId,
    rpcUrl: process.env[`${prefix}_RPC_URL`]?.trim() || CROSSCHAIN_CHAINS[chainId].rpcUrl,
    sourceContract,
    settlementContract,
    tokenAddress: tokenAddress as Address,
    relayerPrivateKey: readPrivateKey(`${prefix}_RELAYER_PRIVATE_KEY`)
  };
}

function readAddress(key: string): Address | undefined {
  const value = process.env[key]?.trim();
  if (!value) {
    return undefined;
  }
  return getAddress(value);
}

function readPrivateKey(key: string): Hex | undefined {
  const value = process.env[key]?.trim();
  if (!value) {
    return undefined;
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${key} must be a 32-byte hex private key.`);
  }
  return value as Hex;
}
