import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  getAddress,
  http,
  isAddress,
  isHex,
  type Address,
  type Hash,
  type Hex,
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

type BaseServerRouteConfig<TChainId extends RemotePaymentSourceChainId | typeof ARC_DESTINATION_CHAIN_ID> = {
  chainId: TChainId;
  rpcUrl: string;
  tokenAddress: Address;
  relayerPrivateKey?: Hex;
};

type SourceRouteConfig = BaseServerRouteConfig<RemotePaymentSourceChainId> & {
  sourceContract: Address;
};

type DestinationRouteConfig = BaseServerRouteConfig<typeof ARC_DESTINATION_CHAIN_ID> & {
  settlementContract: Address;
};

type ServerRouteConfig = SourceRouteConfig | DestinationRouteConfig;

type SourceReceiptLog = {
  address: Address;
  data: Hex;
  topics: [Hex, ...Hex[]] | [];
  logIndex?: number | null;
};

type DecodedSourcePaymentArgs = {
  requestId: Hex;
  payer: Address;
  recipient: Address;
  token: Address;
  amount: bigint;
  destinationChainId: bigint;
  nonce: bigint;
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
    sourceContract: config.sourceContract,
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
    .map((log) => readSourceReceiptLog(log, config.sourceContract))
    .filter((log): log is SourceReceiptLog => log !== undefined)
    .map(decodeSourcePaymentLog)
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

function decodeSourcePaymentLog(log: SourceReceiptLog) {
  try {
    const decoded = decodeEventLog({
      abi: [qrPaymentInitiatedEvent],
      data: log.data,
      eventName: "QrPaymentInitiated",
      topics: log.topics
    });
    if (!isSourcePaymentArgs(decoded.args)) {
      return undefined;
    }
    const args = decoded.args;
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

function readSourceReceiptLog(log: TransactionReceipt["logs"][number], sourceContract: Address): SourceReceiptLog | undefined {
  const value: unknown = log;
  if (!isRecord(value)) {
    return undefined;
  }

  const { address, data, logIndex } = value;
  const topics = readLogTopics(value.topics);
  if (
    typeof address !== "string" ||
    !isAddress(address) ||
    address.toLowerCase() !== sourceContract.toLowerCase() ||
    typeof data !== "string" ||
    !isHex(data) ||
    !topics ||
    (logIndex !== undefined && logIndex !== null && typeof logIndex !== "number")
  ) {
    return undefined;
  }

  return {
    address,
    data,
    topics,
    logIndex: typeof logIndex === "number" ? logIndex : undefined
  };
}

function readLogTopics(value: unknown): SourceReceiptLog["topics"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const topics: Hex[] = [];
  for (const topic of value) {
    if (!isHex(topic)) {
      return undefined;
    }
    topics.push(topic);
  }

  if (topics.length === 0) {
    return [];
  }
  return [topics[0], ...topics.slice(1)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isSourcePaymentArgs(args: unknown): args is DecodedSourcePaymentArgs {
  if (!args || typeof args !== "object") {
    return false;
  }

  const candidate = args as Record<string, unknown>;
  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.payer === "string" &&
    typeof candidate.recipient === "string" &&
    typeof candidate.token === "string" &&
    typeof candidate.amount === "bigint" &&
    typeof candidate.destinationChainId === "bigint" &&
    typeof candidate.nonce === "bigint"
  );
}

async function readSourceReceipt(config: SourceRouteConfig, txHash: Hash): Promise<TransactionReceipt> {
  try {
    return await createServerPublicClient(config).getTransactionReceipt({ hash: txHash });
  } catch {
    throw new HttpError(409, "Source-chain transaction receipt is not available yet.");
  }
}

async function submitSettlement(config: DestinationRouteConfig, proof: Hex): Promise<TransactionReceipt> {
  if (!config.relayerPrivateKey) {
    throw new Error(`Relayer private key for ${CROSSCHAIN_CHAINS[config.chainId].label} is not configured.`);
  }

  const account = privateKeyToAccount(config.relayerPrivateKey);
  const chain = CROSSCHAIN_CHAINS[config.chainId].chain;
  const publicClient = createServerPublicClient(config);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(config.rpcUrl, {
      timeout: 15_000
    })
  });
  const hash = await walletClient.writeContract({
    address: config.settlementContract,
    abi: qrPaymentSettlementAbi,
    functionName: "settle",
    args: [proof]
  });

  return publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1
  });
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
  chainId: RemotePaymentSourceChainId,
  use: "source"
): SourceRouteConfig;
function readServerRouteConfig(
  chainId: typeof ARC_DESTINATION_CHAIN_ID,
  use: "destination"
): DestinationRouteConfig;
function readServerRouteConfig(
  chainId: RemotePaymentSourceChainId | typeof ARC_DESTINATION_CHAIN_ID,
  use: "source" | "destination"
): SourceRouteConfig | DestinationRouteConfig {
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
  const rpcUrl = process.env[`${prefix}_RPC_URL`]?.trim() || CROSSCHAIN_CHAINS[chainId].rpcUrl;
  const relayerPrivateKey = readPrivateKey(`${prefix}_RELAYER_PRIVATE_KEY`);

  if (use === "source") {
    if (!isRemotePaymentSourceChainId(chainId)) {
      throw new Error("Arc cannot be configured as a Polymer source route.");
    }

    if (!tokenAddress || !sourceContract) {
      const missing = [];
      if (!tokenAddress) {
        missing.push("USDC token address");
      }
      if (!sourceContract) {
        missing.push("source contract");
      }
      throw new Error(`Cross-chain ${use} route for ${CROSSCHAIN_CHAINS[chainId].label} is missing ${missing.join(", ")}.`);
    }

    return {
      chainId,
      rpcUrl,
      sourceContract,
      tokenAddress,
      relayerPrivateKey
    };
  }

  if (!tokenAddress || !settlementContract) {
    const missing = [];
    if (!tokenAddress) {
      missing.push("USDC token address");
    }
    if (!settlementContract) {
      missing.push("settlement contract");
    }
    throw new Error(`Cross-chain ${use} route for ${CROSSCHAIN_CHAINS[chainId].label} is missing ${missing.join(", ")}.`);
  }

  return {
    chainId: ARC_DESTINATION_CHAIN_ID,
    rpcUrl,
    settlementContract,
    tokenAddress,
    relayerPrivateKey
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
