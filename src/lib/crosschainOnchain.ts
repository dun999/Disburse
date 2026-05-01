import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  http,
  numberToHex,
  parseUnits,
  type Address,
  type Hash
} from "viem";
import {
  buildCrossChainNonce,
  crossChainErc20Abi,
  getCrossChain,
  isRemotePaymentSourceChainId,
  qrPaymentSourceAbi,
  requestIdToBytes32,
  type PaymentSourceChainId,
  type RemotePaymentSourceChainId
} from "./crosschain";
import { requireCrossChainBrowserRoute } from "./crosschainConfig";
import { getWalletChainId, type Balances, type EthereumProvider, type TransferEstimate } from "./onchain";
import { createExpiry, parseTokenAmount, type PaymentRequest } from "./payments";

const WALLET_APPROVAL_TIMEOUT_MS = 5 * 60_000;
const RECEIPT_WAIT_TIMEOUT_MS = 120_000;
const SOURCE_PAYMENT_GAS_FALLBACK = 150_000n;

export async function switchToCrossChain(provider: EthereumProvider, chainId: PaymentSourceChainId): Promise<void> {
  const config = getCrossChain(chainId);
  const hexChainId = `0x${chainId.toString(16)}`;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: hexChainId }]
    });
  } catch (error) {
    const code = readProviderErrorCode(error);
    if (code !== 4902) {
      throw error;
    }

    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: hexChainId,
          chainName: config.label,
          nativeCurrency: {
            name: "Ether",
            symbol: config.nativeSymbol,
            decimals: 18
          },
          rpcUrls: [config.rpcUrl],
          blockExplorerUrls: [config.explorerUrl]
        }
      ]
    });
  }
}

export async function readCrossChainBalances(
  account: Address,
  request: PaymentRequest,
  sourceChainId: RemotePaymentSourceChainId
): Promise<Balances> {
  const route = requireCrossChainBrowserRoute(sourceChainId);
  const client = createCrossChainPublicClient(sourceChainId);
  const [nativeBalance, tokenBalance, gasPrice] = await Promise.all([
    client.getBalance({ address: account }),
    client.readContract({
      address: route.tokenAddress,
      abi: crossChainErc20Abi,
      functionName: "balanceOf",
      args: [account]
    }),
    client.getGasPrice()
  ]);

  return {
    nativeGas: formatUnits(nativeBalance, 18),
    tokenBalance: formatUnits(tokenBalance, 6),
    gasPrice: formatUnits(gasPrice, 18)
  };
}

export async function estimateCrossChainPayment(
  account: Address,
  request: PaymentRequest,
  sourceChainId: RemotePaymentSourceChainId
): Promise<TransferEstimate> {
  const route = requireCrossChainBrowserRoute(sourceChainId);
  const client = createCrossChainPublicClient(sourceChainId);
  const amount = parseTokenAmount(request.amount, request.token);
  const allowance = await client.readContract({
    address: route.tokenAddress,
    abi: crossChainErc20Abi,
    functionName: "allowance",
    args: [account, route.sourceContract]
  });
  const needsApproval = allowance < amount;
  const gasPrice = await client.getGasPrice();
  const approvalGas = needsApproval
    ? await client.estimateContractGas({
        account,
        address: route.tokenAddress,
        abi: crossChainErc20Abi,
        functionName: "approve",
        args: [route.sourceContract, amount]
      })
    : 0n;
  const paymentGas = await estimateSourcePaymentGas(
    () =>
      client.estimateContractGas({
        account,
        address: route.sourceContract,
        abi: qrPaymentSourceAbi,
        functionName: "pay",
        args: buildCrossChainPayArgs(request, sourceChainId, route.tokenAddress)
      }),
    needsApproval
  );
  const totalGas = approvalGas + paymentGas;

  return {
    gas: totalGas,
    gasPrice,
    fee: formatUnits(totalGas * gasPrice, 18),
    nativeSymbol: getCrossChain(sourceChainId).nativeSymbol,
    approvalGas: needsApproval ? approvalGas : undefined,
    paymentGas,
    needsApproval
  };
}

export async function submitCrossChainPayment(
  provider: EthereumProvider,
  account: Address,
  request: PaymentRequest,
  sourceChainId: RemotePaymentSourceChainId
): Promise<Hash> {
  const walletChainId = await getWalletChainId(provider);
  if (walletChainId !== sourceChainId) {
    throw new Error(`Wallet is not on ${getCrossChain(sourceChainId).label}. Switch networks, then try again.`);
  }

  const route = requireCrossChainBrowserRoute(sourceChainId);
  const client = createCrossChainPublicClient(sourceChainId);
  const amount = parseTokenAmount(request.amount, request.token);
  const allowance = await client.readContract({
    address: route.tokenAddress,
    abi: crossChainErc20Abi,
    functionName: "allowance",
    args: [account, route.sourceContract]
  });

  if (allowance < amount) {
    const approveHash = await requestWalletTransaction(provider, {
      from: account,
      to: route.tokenAddress,
      data: encodeFunctionData({
        abi: crossChainErc20Abi,
        functionName: "approve",
        args: [route.sourceContract, amount]
      }),
      value: "0x0"
    });
    await waitForCrossChainReceipt(sourceChainId, approveHash);
    const confirmedAllowance = await client.readContract({
      address: route.tokenAddress,
      abi: crossChainErc20Abi,
      functionName: "allowance",
      args: [account, route.sourceContract]
    });
    if (confirmedAllowance < amount) {
      throw new Error(
        `USDC approval confirmed, but ${getCrossChain(sourceChainId).label} still reports insufficient allowance for the QR payment contract. Approve spender ${route.sourceContract}, then try again.`
      );
    }
  }

  return requestWalletTransaction(provider, {
    from: account,
    to: route.sourceContract,
    data: encodeFunctionData({
      abi: qrPaymentSourceAbi,
      functionName: "pay",
      args: buildCrossChainPayArgs(request, sourceChainId, route.tokenAddress)
    }),
    value: "0x0",
    nonce: numberToHex(await readPendingNonceOnChain(account, sourceChainId))
  });
}

export async function waitForCrossChainReceipt(sourceChainId: RemotePaymentSourceChainId, hash: Hash): Promise<void> {
  await withTimeout(
    createCrossChainPublicClient(sourceChainId).waitForTransactionReceipt({
      hash,
      confirmations: 1
    }),
    RECEIPT_WAIT_TIMEOUT_MS,
    `Transaction ${hash} was submitted, but ${getCrossChain(sourceChainId).label} did not return a receipt yet. Use Verify in a minute.`
  );
}

export function createCrossChainPublicClient(chainId: PaymentSourceChainId) {
  const config = getCrossChain(chainId);
  return createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl, {
      timeout: 10_000
    })
  });
}

function buildCrossChainPayArgs(
  request: PaymentRequest,
  sourceChainId: RemotePaymentSourceChainId,
  tokenAddress: Address
): readonly [ReturnType<typeof requestIdToBytes32>, Address, Address, bigint, bigint, bigint, bigint] {
  if (request.token !== "USDC") {
    throw new Error("Arc-settlement QR payments currently support USDC routes only.");
  }
  if (!request.destinationChainId) {
    throw new Error("Arc-settlement QR request is missing the Arc destination chain.");
  }
  if (!isRemotePaymentSourceChainId(sourceChainId)) {
    throw new Error("Source chain must be Base Sepolia or MegaETH for escrow payment.");
  }

  return [
    requestIdToBytes32(request.id),
    getAddress(request.recipient),
    tokenAddress,
    parseTokenAmount(request.amount, request.token),
    BigInt(request.destinationChainId),
    BigInt(Math.floor(Date.parse(request.expiresAt ?? createExpiry(request.createdAt)) / 1000)),
    buildCrossChainNonce(request.id, sourceChainId, request.destinationChainId)
  ];
}

async function readPendingNonceOnChain(account: Address, sourceChainId: RemotePaymentSourceChainId): Promise<number> {
  return createCrossChainPublicClient(sourceChainId).getTransactionCount({
    address: account,
    blockTag: "pending"
  });
}

async function estimateSourcePaymentGas(estimate: () => Promise<bigint>, needsApproval: boolean): Promise<bigint> {
  try {
    return await estimate();
  } catch (error) {
    if (!needsApproval || !isAllowanceRevert(error)) {
      throw error;
    }

    return SOURCE_PAYMENT_GAS_FALLBACK;
  }
}

async function requestWalletTransaction(
  provider: EthereumProvider,
  transaction: {
    from: Address;
    to: Address;
    data: `0x${string}`;
    value: "0x0";
    nonce?: `0x${string}`;
  }
): Promise<Hash> {
  const hash = await withTimeout(
    provider.request({
      method: "eth_sendTransaction",
      params: [transaction]
    }),
    WALLET_APPROVAL_TIMEOUT_MS,
    "Wallet approval did not open or return a transaction hash. Reopen this request in your wallet browser, then try again."
  );

  if (typeof hash !== "string" || !/^0x[a-fA-F0-9]{64}$/.test(hash)) {
    throw new Error("Wallet did not return a valid transaction hash.");
  }

  return hash as Hash;
}

function readProviderErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return Number((error as { code?: unknown }).code);
  }
  return undefined;
}

function isAllowanceRevert(error: unknown): boolean {
  return readErrorText(error).some((message) => /allowance|transfer amount exceeds allowance/i.test(message));
}

function readErrorText(error: unknown, seen = new Set<unknown>()): string[] {
  if (typeof error === "string") {
    return [error];
  }
  if (typeof error !== "object" || error === null) {
    return [];
  }
  if (seen.has(error)) {
    return [];
  }
  seen.add(error);

  const source = error as {
    message?: unknown;
    shortMessage?: unknown;
    details?: unknown;
    metaMessages?: unknown;
    cause?: unknown;
  };
  const messages = [source.message, source.shortMessage, source.details].filter(
    (value): value is string => typeof value === "string"
  );

  if (Array.isArray(source.metaMessages)) {
    messages.push(...source.metaMessages.filter((value): value is string => typeof value === "string"));
  }

  return [...messages, ...readErrorText(source.cause, seen)];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
