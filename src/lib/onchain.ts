import {
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  parseGwei,
  type Address,
  type EIP1193Provider,
  type Hash
} from "viem";
import {
  ARC_CHAIN_ID,
  ARC_EXPLORER_URL,
  ARC_RPC_URL,
  TOKENS,
  arcTestnet,
  erc20Abi,
  publicClient,
  transferEvent
} from "./arc";
import {
  decodeTransferLog,
  makeReceipt,
  parseTokenAmount,
  transferMatchesRequest,
  type DecodedTransfer,
  type PaymentRequest,
  type Receipt
} from "./payments";

export type EthereumProvider = EIP1193Provider & {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type Balances = {
  nativeGas: string;
  tokenBalance: string;
  gasPrice: string;
};

export type TransferEstimate = {
  gas: bigint;
  gasPrice: bigint;
  fee: string;
};

export type VerificationResult =
  | { status: "paid"; receipt: Receipt; message: string }
  | { status: "possible_match"; transfer: DecodedTransfer; message: string }
  | { status: "open"; message: string };

export function getInjectedProvider(): EthereumProvider | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.ethereum as EthereumProvider | undefined;
}

export async function connectWallet(provider: EthereumProvider): Promise<Address> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) {
    throw new Error("Wallet did not return an account.");
  }
  return getAddress(accounts[0]);
}

export async function getWalletChainId(provider: EthereumProvider): Promise<number> {
  const chainId = (await provider.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(chainId, 16);
}

export async function switchToArc(provider: EthereumProvider): Promise<void> {
  const chainId = `0x${ARC_CHAIN_ID.toString(16)}`;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId }]
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
          chainId,
          chainName: "Arc Testnet",
          nativeCurrency: {
            name: "USDC",
            symbol: "USDC",
            decimals: 18
          },
          rpcUrls: [ARC_RPC_URL],
          blockExplorerUrls: [ARC_EXPLORER_URL]
        }
      ]
    });
  }
}

export async function readBalances(account: Address, request: PaymentRequest): Promise<Balances> {
  const [nativeBalance, tokenBalance, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: account }),
    publicClient.readContract({
      address: TOKENS[request.token].address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account]
    }),
    publicClient.getGasPrice()
  ]);

  return {
    nativeGas: formatUnits(nativeBalance, 18),
    tokenBalance: formatUnits(tokenBalance, TOKENS[request.token].decimals),
    gasPrice: formatUnits(gasPrice, 18)
  };
}

export async function estimatePayment(account: Address, request: PaymentRequest): Promise<TransferEstimate> {
  const amount = parseTokenAmount(request.amount, request.token);
  const gasPrice = await currentSafeGasPrice();
  const gas = await publicClient.estimateContractGas({
    account,
    address: TOKENS[request.token].address,
    abi: erc20Abi,
    functionName: "transfer",
    args: [request.recipient, amount],
    gasPrice
  });

  return {
    gas,
    gasPrice,
    fee: formatUnits(gas * gasPrice, 18)
  };
}

export async function sendPayment(
  provider: EthereumProvider,
  account: Address,
  request: PaymentRequest,
  estimate?: TransferEstimate
): Promise<Hash> {
  const walletClient = createWalletClient({
    account,
    chain: arcTestnet,
    transport: custom(provider)
  });

  const amount = parseTokenAmount(request.amount, request.token);
  const transfer = {
    account,
    chain: arcTestnet,
    address: TOKENS[request.token].address,
    abi: erc20Abi,
    functionName: "transfer",
    args: [request.recipient, amount]
  } as const;

  const hash = await walletClient.writeContract(
    estimate
      ? {
          ...transfer,
          gas: estimate.gas,
          gasPrice: estimate.gasPrice
        }
      : transfer
  );

  await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1
  });

  return hash;
}

export async function verifyPayment(request: PaymentRequest): Promise<VerificationResult> {
  const exactAmount = parseTokenAmount(request.amount, request.token);

  if (request.txHash) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: request.txHash });
      const transfer = receipt.logs
        .filter((log) => log.address.toLowerCase() === TOKENS[request.token].address.toLowerCase())
        .map(decodeTransferLog)
        .find((decoded): decoded is DecodedTransfer => Boolean(decoded));

      if (transfer && transferMatchesRequest(request, transfer)) {
        return {
          status: "paid",
          receipt: makeReceipt(request, transfer),
          message: "Receipt verified from transaction logs."
        };
      }
    } catch {
      return {
        status: "open",
        message: "Transaction hash is not available on Arcscan yet."
      };
    }
  }

  const logs = await publicClient.getLogs({
    address: TOKENS[request.token].address,
    event: transferEvent,
    args: {
      to: request.recipient
    },
    fromBlock: BigInt(request.startBlock),
    toBlock: "latest"
  });

  const transfers = logs
    .map((log) => ({
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      from: getAddress(log.args.from ?? "0x0000000000000000000000000000000000000000"),
      to: getAddress(log.args.to ?? request.recipient),
      value: log.args.value ?? 0n
    }))
    .filter((transfer): transfer is DecodedTransfer => Boolean(transfer.txHash && transfer.blockNumber));

  const exact = transfers.find((transfer) => transfer.value === exactAmount);
  if (exact) {
    return {
      status: "paid",
      receipt: makeReceipt(request, exact),
      message: "Exact transfer found on Arc Testnet."
    };
  }

  const possible = transfers.at(-1);
  if (possible) {
    return {
      status: "possible_match",
      transfer: possible,
      message: "A transfer to this recipient exists, but the amount differs."
    };
  }

  return {
    status: "open",
    message: "No matching transfer found from the request start block."
  };
}

export async function checkArcRpc() {
  const [chainId, blockNumber, gasPrice, usdcDecimals, eurcDecimals] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlockNumber(),
    publicClient.getGasPrice(),
    publicClient.readContract({
      address: TOKENS.USDC.address,
      abi: erc20Abi,
      functionName: "decimals"
    }),
    publicClient.readContract({
      address: TOKENS.EURC.address,
      abi: erc20Abi,
      functionName: "decimals"
    })
  ]);

  return {
    chainId,
    blockNumber: blockNumber.toString(),
    gasPrice: formatUnits(gasPrice, 18),
    usdcDecimals,
    eurcDecimals
  };
}

async function currentSafeGasPrice(): Promise<bigint> {
  const gasPrice = await publicClient.getGasPrice();
  const minimum = parseGwei("20");
  return gasPrice > minimum ? gasPrice : minimum;
}

function readProviderErrorCode(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    return Number((error as { code?: unknown }).code);
  }
  return undefined;
}
