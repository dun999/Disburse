import { type FormEvent, type MouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { formatUnits } from "viem";
import { ARC_CHAIN_ID, ARC_DOCS_URL, ARC_FAUCET_URL, ARC_EXPLORER_URL, ARC_RPC_URL, publicClient, TOKENS } from "./lib/arc";
import { errorToMessage } from "./lib/errors";
import {
  checkArcRpc,
  connectWallet,
  estimatePayment,
  getInjectedProvider,
  getWalletChainId,
  readBalances,
  sendPayment,
  switchToArc,
  verifyPayment,
  type Balances,
  type TransferEstimate
} from "./lib/onchain";
import {
  buildShareUrl,
  decodeRequestPayload,
  formatTokenAmount,
  normalizeLabel,
  normalizeNote,
  parseTokenAmount,
  shortAddress,
  validateRecipient,
  type PaymentRequest,
  type PaymentStatus,
  type PaymentToken,
  type Receipt
} from "./lib/payments";
import {
  buildExportBundle,
  loadReceipts,
  loadRequests,
  parseExportBundle,
  saveReceipts,
  saveRequests,
  upsertReceipt,
  upsertRequest
} from "./lib/storage";

type FormState = {
  recipient: string;
  token: PaymentToken;
  amount: string;
  label: string;
  note: string;
  dueAt: string;
};

type Notice = {
  tone: "info" | "success" | "error";
  text: string;
};

type RpcHealth = Awaited<ReturnType<typeof checkArcRpc>>;
type Theme = "light" | "dark";
type Page = "home" | "docs";
type NavigateHandler = (event: MouseEvent<HTMLAnchorElement>, target: string) => void;
type DocsSection = {
  title: string;
  body: string;
  points?: string[];
  code?: string;
};

const emptyForm: FormState = {
  recipient: "",
  token: "USDC",
  amount: "",
  label: "",
  note: "",
  dueAt: ""
};

const THEME_KEY = "disburse.theme";
const LEGACY_THEME_KEY = "arc-pay-desk.theme";

const faqItems = [
  {
    question: "Does this app custody funds?",
    answer:
      "No. Payments are submitted from the connected wallet directly to the recipient address. The app does not hold private keys or stablecoin balances."
  },
  {
    question: "Which network does Disburse use?",
    answer:
      "Disburse is configured for Arc Testnet, chain ID 5042002, using the public Arc RPC endpoint and Arcscan for transaction review."
  },
  {
    question: "What is stored in the browser?",
    answer:
      "Requests and receipts are stored in localStorage. Export the ledger before clearing browser data or moving to another device."
  },
  {
    question: "How is a payment verified?",
    answer:
      "Disburse checks a known transaction receipt when available. If no receipt hash is present, it scans ERC-20 Transfer logs from the request start block."
  }
];

const docsSections: DocsSection[] = [
  {
    title: "Runtime model",
    body:
      "Disburse is a client-side payment console. It does not operate a backend, hold credentials, relay signatures, or custody funds. The browser composes requests, the wallet signs transfers, and the public Arc RPC is used for chain reads.",
    points: [
      "Injected wallet: account discovery, chain switching, and transaction signing.",
      "Public client: block, gas, balances, token metadata, receipts, and Transfer logs.",
      "Local browser storage: request ledger and verified receipts."
    ]
  },
  {
    title: "Chain and assets",
    body:
      "The app is pinned to Arc Testnet. Native gas is represented as USDC with 18 decimals, while supported ERC-20 payment amounts use 6 decimals.",
    points: [
      `Chain ID: ${ARC_CHAIN_ID}`,
      `RPC: ${new URL(ARC_RPC_URL).host}`,
      `USDC: ${TOKENS.USDC.address}`,
      `EURC: ${TOKENS.EURC.address}`
    ]
  },
  {
    title: "Request format",
    body:
      "A request link carries a base64url JSON payload in the r query parameter. The payload is self-contained enough to reconstruct the payable request, but it never contains private keys, wallet secrets, or browser ledger state.",
    code: "/pay?r=<base64url({ version, id, recipient, token, amount, label, note?, dueAt?, createdAt, startBlock })>"
  },
  {
    title: "Payment execution",
    body:
      "The payer connects an injected wallet, switches to Arc Testnet, reviews live token and native gas balances, estimates the ERC-20 transfer, then submits transfer(recipient, amount) from the wallet account.",
    points: [
      "The app validates token balance before requesting a signature.",
      "Gas estimates are displayed to the payer and reused for the wallet transaction when available.",
      "Wallet rejection leaves the request open and does not mutate the receipt ledger."
    ]
  },
  {
    title: "Settlement verification",
    body:
      "Verification first checks a stored transaction hash. If no hash is present, it scans ERC-20 Transfer logs from the request start block to latest and compares the recipient and exact token amount.",
    code: "match = log.address == token && log.args.to == recipient && log.args.value == parseUnits(amount, 6)"
  },
  {
    title: "Persistence boundary",
    body:
      "Requests and receipts remain local to the current browser profile. Export/import is the migration path between devices or profiles, and clearing site data removes the local ledger.",
    points: [
      "Requests: recipient, token, amount, label, note, due date, creation time, start block, status.",
      "Receipts: request id, transaction hash, sender, recipient, token, amount, block, confirmation time.",
      "No cloud sync is performed by this build."
    ]
  },
  {
    title: "Failure modes",
    body:
      "Most failed pay attempts are wallet rejection, wrong network, insufficient token balance, RPC congestion, or transaction pool saturation. These conditions should be retried after the wallet/network state is corrected.",
    points: [
      "Wrong network: switch or add Arc Testnet through the injected wallet.",
      "Txpool full: no hash was returned; wait briefly and submit again.",
      "Verification open: wait for indexing or rescan from the request start block."
    ]
  }
];

function getInitialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY) ?? localStorage.getItem(LEGACY_THEME_KEY);
  const nextTheme = stored === "light" || stored === "dark" ? stored : "dark";
  document.documentElement.dataset.theme = nextTheme;
  return nextTheme;
}

function getInitialPage(): Page {
  return window.location.pathname === "/docs" ? "docs" : "home";
}

function App() {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [page, setPage] = useState<Page>(() => getInitialPage());
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [form, setForm] = useState<FormState>(emptyForm);
  const [requests, setRequests] = useState<PaymentRequest[]>(() => loadRequests());
  const [receipts, setReceipts] = useState<Receipt[]>(() => loadReceipts());
  const [selectedId, setSelectedId] = useState<string | undefined>(() => loadRequests()[0]?.id);
  const [shareUrl, setShareUrl] = useState("");
  const [createNotice, setCreateNotice] = useState<Notice | undefined>();
  const [payNotice, setPayNotice] = useState<Notice | undefined>();
  const [walletNotice, setWalletNotice] = useState<Notice | undefined>();
  const [account, setAccount] = useState<`0x${string}` | undefined>();
  const [chainId, setChainId] = useState<number | undefined>();
  const [balances, setBalances] = useState<Balances | undefined>();
  const [estimate, setEstimate] = useState<TransferEstimate | undefined>();
  const [rpcHealth, setRpcHealth] = useState<RpcHealth | undefined>();
  const [isCreating, setIsCreating] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isEstimating, setIsEstimating] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  const selectedRequest = useMemo(
    () => requests.find((request) => request.id === selectedId) ?? requests[0],
    [requests, selectedId]
  );

  const selectedReceipt = useMemo(
    () => receipts.find((receipt) => receipt.requestId === selectedRequest?.id),
    [receipts, selectedRequest?.id]
  );

  const wrongChain = Boolean(account && chainId !== undefined && chainId !== ARC_CHAIN_ID);

  const insufficientToken = useMemo(() => {
    if (!selectedRequest || !balances) {
      return false;
    }
    try {
      return (
        parseTokenAmount(balances.tokenBalance, selectedRequest.token) <
        parseTokenAmount(selectedRequest.amount, selectedRequest.token)
      );
    } catch {
      return false;
    }
  }, [balances, selectedRequest]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", theme === "dark" ? "#0e0f0d" : "#f7f6f3");
  }, [theme]);

  useEffect(() => {
    const handlePopState = () => {
      setPage(getInitialPage());
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    saveRequests(requests);
  }, [requests]);

  useEffect(() => {
    saveReceipts(receipts);
  }, [receipts]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get("r");
    if (!encoded) {
      return;
    }

    try {
      const decoded = decodeRequestPayload(encoded);
      setRequests((current) => upsertRequest(current, decoded));
      setSelectedId(decoded.id);
      setPayNotice({ tone: "info", text: "Payment request loaded from URL." });
    } catch (error) {
      setPayNotice({ tone: "error", text: errorToMessage(error) });
    }
  }, []);

  useEffect(() => {
    const provider = getInjectedProvider();
    if (!provider?.on) {
      return;
    }

    const handleAccounts = (value: unknown) => {
      const accounts = value as string[];
      setAccount(accounts?.[0] ? validateRecipient(accounts[0]) : undefined);
      setBalances(undefined);
      setEstimate(undefined);
    };

    const handleChain = (value: unknown) => {
      setChainId(Number.parseInt(String(value), 16));
      setBalances(undefined);
      setEstimate(undefined);
    };

    provider.on("accountsChanged", handleAccounts);
    provider.on("chainChanged", handleChain);

    return () => {
      provider.removeListener?.("accountsChanged", handleAccounts);
      provider.removeListener?.("chainChanged", handleChain);
    };
  }, []);

  useEffect(() => {
    let isActive = true;

    const refreshRpcHealth = async () => {
      try {
        const nextHealth = await checkArcRpc();
        if (isActive) {
          setRpcHealth(nextHealth);
        }
      } catch {
        if (isActive) {
          setRpcHealth(undefined);
        }
      }
    };

    void refreshRpcHealth();
    const interval = window.setInterval(refreshRpcHealth, 6_000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!account || !selectedRequest || wrongChain) {
      return;
    }
    void refreshBalances(selectedRequest);
  }, [account, selectedRequest?.id, selectedRequest?.token, wrongChain]);

  async function handleCreateRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCreating(true);
    setCreateNotice(undefined);

    try {
      const recipient = validateRecipient(form.recipient);
      const token = form.token;
      const amount = formatTokenAmount(parseTokenAmount(form.amount, token), token);
      const blockNumber = await publicClient.getBlockNumber();
      const request: PaymentRequest = {
        id: crypto.randomUUID(),
        recipient,
        token,
        amount,
        label: normalizeLabel(form.label),
        note: normalizeNote(form.note),
        dueAt: form.dueAt || undefined,
        createdAt: new Date().toISOString(),
        startBlock: blockNumber.toString(),
        status: "open"
      };

      setRequests((current) => upsertRequest(current, request));
      setSelectedId(request.id);
      setShareUrl(buildShareUrl(request, window.location.origin));
      setCreateNotice({ tone: "success", text: "Request created." });
      setForm((current) => ({ ...emptyForm, recipient: current.recipient, token: current.token }));
    } catch (error) {
      setCreateNotice({ tone: "error", text: errorToMessage(error) });
    } finally {
      setIsCreating(false);
    }
  }

  async function handleConnectWallet() {
    const provider = getInjectedProvider();
    if (!provider) {
      setWalletNotice({ tone: "error", text: "No injected wallet found." });
      return;
    }

    setIsConnecting(true);
    setWalletNotice(undefined);

    try {
      const nextAccount = await connectWallet(provider);
      const nextChainId = await getWalletChainId(provider);
      setAccount(nextAccount);
      setChainId(nextChainId);
      setWalletNotice({ tone: "success", text: "Wallet connected." });
    } catch (error) {
      setWalletNotice({ tone: "error", text: errorToMessage(error) });
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleSwitchNetwork() {
    const provider = getInjectedProvider();
    if (!provider) {
      setWalletNotice({ tone: "error", text: "No injected wallet found." });
      return;
    }

    setIsConnecting(true);
    setWalletNotice(undefined);

    try {
      await switchToArc(provider);
      const nextChainId = await getWalletChainId(provider);
      setChainId(nextChainId);
      setWalletNotice({ tone: "success", text: "Arc Testnet selected." });
    } catch (error) {
      setWalletNotice({ tone: "error", text: errorToMessage(error) });
    } finally {
      setIsConnecting(false);
    }
  }

  async function handleEstimate() {
    if (!selectedRequest || !account) {
      setPayNotice({ tone: "error", text: "Connect a wallet and select a request." });
      return;
    }
    if (wrongChain) {
      setPayNotice({ tone: "error", text: "Switch to Arc Testnet before estimating." });
      return;
    }

    setIsEstimating(true);
    setPayNotice({ tone: "info", text: "Estimating transfer." });

    try {
      const nextEstimate = await estimatePayment(account, selectedRequest);
      setEstimate(nextEstimate);
      await refreshBalances(selectedRequest);
      setPayNotice({ tone: "success", text: "Estimate ready." });
    } catch (error) {
      setPayNotice({ tone: "error", text: errorToMessage(error) });
    } finally {
      setIsEstimating(false);
    }
  }

  async function handlePay() {
    const provider = getInjectedProvider();
    if (!selectedRequest || !provider || !account) {
      setPayNotice({ tone: "error", text: "Connect a wallet and select a request." });
      return;
    }

    if (wrongChain) {
      setPayNotice({ tone: "error", text: "Switch to Arc Testnet before paying." });
      return;
    }

    setIsPaying(true);
    setPayNotice({ tone: "info", text: "Preparing payment." });

    try {
      const freshBalances = await readBalances(account, selectedRequest);
      setBalances(freshBalances);
      if (
        parseTokenAmount(freshBalances.tokenBalance, selectedRequest.token) <
        parseTokenAmount(selectedRequest.amount, selectedRequest.token)
      ) {
        throw new Error(`Insufficient ${selectedRequest.token} balance.`);
      }

      let paymentEstimate = estimate;
      if (!paymentEstimate) {
        setPayNotice({ tone: "info", text: "Estimating transfer." });
        paymentEstimate = await estimatePayment(account, selectedRequest);
        setEstimate(paymentEstimate);
      }

      setPayNotice({ tone: "info", text: "Waiting for wallet approval." });
      const hash = await sendPayment(provider, account, selectedRequest, paymentEstimate);
      setPayNotice({ tone: "info", text: "Transaction submitted. Verifying receipt." });

      const requestWithHash = { ...selectedRequest, txHash: hash };
      const result = await verifyPayment(requestWithHash);
      if (result.status === "paid") {
        const paidRequest: PaymentRequest = { ...requestWithHash, status: "paid" };
        setRequests((current) => upsertRequest(current, paidRequest));
        setReceipts((current) => upsertReceipt(current, result.receipt));
        setPayNotice({ tone: "success", text: "Payment confirmed." });
      } else {
        setRequests((current) => upsertRequest(current, { ...requestWithHash, status: result.status }));
        setPayNotice({ tone: result.status === "possible_match" ? "info" : "error", text: result.message });
      }
    } catch (error) {
      setPayNotice({ tone: "error", text: errorToMessage(error) });
    } finally {
      setIsPaying(false);
    }
  }

  async function handleVerify(request = selectedRequest) {
    if (!request) {
      return;
    }

    setIsVerifying(true);
    setPayNotice({ tone: "info", text: "Scanning Arc Testnet logs." });

    try {
      const result = await verifyPayment(request);
      if (result.status === "paid") {
        setRequests((current) => upsertRequest(current, { ...request, status: "paid", txHash: result.receipt.txHash }));
        setReceipts((current) => upsertReceipt(current, result.receipt));
        setPayNotice({ tone: "success", text: result.message });
      } else {
        setRequests((current) => upsertRequest(current, { ...request, status: result.status }));
        setPayNotice({ tone: result.status === "possible_match" ? "info" : "error", text: result.message });
      }
    } catch (error) {
      setPayNotice({ tone: "error", text: errorToMessage(error) });
    } finally {
      setIsVerifying(false);
    }
  }

  async function refreshBalances(request = selectedRequest) {
    if (!account || !request) {
      return;
    }
    try {
      const nextBalances = await readBalances(account, request);
      setBalances(nextBalances);
    } catch (error) {
      setPayNotice({ tone: "error", text: errorToMessage(error) });
    }
  }

  async function copyValue(value: string, notice: (notice: Notice) => void) {
    await navigator.clipboard.writeText(value);
    notice({ tone: "success", text: "Copied." });
  }

  function handleSelectRequest(request: PaymentRequest) {
    setSelectedId(request.id);
    setEstimate(undefined);
    setPayNotice(undefined);
    setShareUrl(buildShareUrl(request, window.location.origin));
  }

  function handleExport() {
    const bundle = buildExportBundle(requests, receipts);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "disburse-export.json";
    link.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(file: File | undefined) {
    if (!file) {
      return;
    }

    try {
      const bundle = parseExportBundle(await file.text());
      setRequests((current) => {
        const merged = [...current];
        for (const request of bundle.requests) {
          const index = merged.findIndex((item) => item.id === request.id);
          if (index === -1) {
            merged.push(request);
          } else {
            merged[index] = request;
          }
        }
        return merged;
      });
      setReceipts((current) => {
        const merged = [...current];
        for (const receipt of bundle.receipts) {
          const index = merged.findIndex((item) => item.txHash === receipt.txHash || item.requestId === receipt.requestId);
          if (index === -1) {
            merged.push(receipt);
          } else {
            merged[index] = receipt;
          }
        }
        return merged;
      });
      setCreateNotice({ tone: "success", text: "Import complete." });
    } catch (error) {
      setCreateNotice({ tone: "error", text: errorToMessage(error) });
    }
  }

  function handleNavigate(event: MouseEvent<HTMLAnchorElement>, target: string) {
    event.preventDefault();

    const [pathPart, hashPart] = target.split("#");
    const nextPath = pathPart || "/";
    const nextUrl = `${nextPath}${hashPart ? `#${hashPart}` : ""}`;

    if (`${window.location.pathname}${window.location.hash}` !== nextUrl) {
      window.history.pushState(null, "", nextUrl);
    }

    setPage(nextPath === "/docs" ? "docs" : "home");
    window.setTimeout(() => {
      if (hashPart) {
        document.getElementById(hashPart)?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    }, 0);
  }

  function handleThemeToggle() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  if (page === "docs") {
    return (
      <main className="site-shell">
        <TopNav
          page={page}
          theme={theme}
          account={account}
          chainId={chainId}
          isConnecting={isConnecting}
          onConnect={handleConnectWallet}
          onSwitch={handleSwitchNetwork}
          onNavigate={handleNavigate}
          onToggleTheme={handleThemeToggle}
        />
        <DocsPage />
        <SiteFooter onNavigate={handleNavigate} />
      </main>
    );
  }

  return (
    <main className="site-shell">
      <TopNav
        page={page}
        theme={theme}
        account={account}
        chainId={chainId}
        isConnecting={isConnecting}
        onConnect={handleConnectWallet}
        onSwitch={handleSwitchNetwork}
        onNavigate={handleNavigate}
        onToggleTheme={handleThemeToggle}
      />

      <section id="top" className="hero">
        <div>
          <p className="eyebrow">Arc Testnet stablecoin requests</p>
          <h1>One page to request, pay, and prove settlement.</h1>
        </div>
      </section>

      <section className="system-strip-rail" aria-label="Network status">
        <div className="system-strip">
          <Metric label="live block" value={rpcHealth ? `block ${rpcHealth.blockNumber}` : "checking"} />
          <Metric label="live gas" value={rpcHealth ? `${trimDisplay(rpcHealth.gasPrice, 8)} USDC` : "pending"} />
          <Metric label="chain" value={String(ARC_CHAIN_ID)} />
          <Metric label="USDC" value={rpcHealth ? `${rpcHealth.usdcDecimals} decimals` : "pending"} />
          <Metric label="EURC" value={rpcHealth ? `${rpcHealth.eurcDecimals} decimals` : "pending"} />
        </div>
      </section>

      <section id="console" className="workbench">
        <header className="section-header">
          <h2>Payments</h2>
        </header>

        <div className="desk-grid">
          <section className="desk-pane create-pane" aria-labelledby="create-heading">
            <PaneTitle id="create-heading" label="Create request" />
            <form className="form-stack" onSubmit={handleCreateRequest}>
              <Field label="Recipient" helper="0x address receiving payment">
                <div className="input-row">
                  <input
                    value={form.recipient}
                    onChange={(event) => setForm((current) => ({ ...current, recipient: event.target.value }))}
                    placeholder="0x..."
                    spellCheck={false}
                  />
                  <button
                    className="utility-button"
                    type="button"
                    aria-label="Use connected wallet"
                    title="Use connected wallet"
                    onClick={() => account && setForm((current) => ({ ...current, recipient: account }))}
                    disabled={!account}
                  >
                    Me
                  </button>
                </div>
              </Field>

              <div className="field-grid">
                <Field label="Token">
                  <select
                    value={form.token}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, token: event.target.value as PaymentToken }))
                    }
                  >
                    <option value="USDC">USDC</option>
                    <option value="EURC">EURC</option>
                  </select>
                </Field>
                <Field label="Amount">
                  <input
                    value={form.amount}
                    onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))}
                    inputMode="decimal"
                    placeholder="125.50"
                  />
                </Field>
              </div>

              <Field label="Label">
                <input
                  value={form.label}
                  onChange={(event) => setForm((current) => ({ ...current, label: event.target.value }))}
                  placeholder="Invoice 7421"
                />
              </Field>

              <Field label="Note" helper="Optional">
                <textarea
                  value={form.note}
                  onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
                  placeholder="Reference, order, or settlement details"
                  rows={3}
                />
              </Field>

              <Field label="Due date" helper="Optional">
                <input
                  type="date"
                  value={form.dueAt}
                  onChange={(event) => setForm((current) => ({ ...current, dueAt: event.target.value }))}
                />
              </Field>

              <button className="primary-button" type="submit" disabled={isCreating}>
                {isCreating ? "Generating..." : "Generate request"}
              </button>
            </form>

            {createNotice && <NoticeBar notice={createNotice} />}

            {shareUrl && (
              <div className="share-line">
                <span>Share URL</span>
                <code>{shareUrl}</code>
                <button className="secondary-button" type="button" onClick={() => copyValue(shareUrl, setCreateNotice)}>
                  Copy link
                </button>
              </div>
            )}
          </section>

          <section className="desk-pane pay-pane" aria-labelledby="pay-heading">
            <PaneTitle id="pay-heading" label="Pay and verify" />
            {selectedRequest ? (
              <>
                <div className="request-summary">
                  <div>
                    <StatusBadge status={selectedRequest.status} />
                    <h3>{selectedRequest.label}</h3>
                    {selectedRequest.note && <p>{selectedRequest.note}</p>}
                  </div>
                  <div className="amount-lockup">
                    <strong>
                      {selectedRequest.amount} {selectedRequest.token}
                    </strong>
                    <span>{shortAddress(selectedRequest.recipient)}</span>
                  </div>
                </div>

                {walletNotice && <NoticeBar notice={walletNotice} compact />}
                {!account && (
                  <button className="primary-button" type="button" onClick={handleConnectWallet} disabled={isConnecting}>
                    {isConnecting ? "Connecting..." : "Connect wallet"}
                  </button>
                )}
                {account && wrongChain && (
                  <button className="danger-button" type="button" onClick={handleSwitchNetwork} disabled={isConnecting}>
                    Switch to Arc
                  </button>
                )}
                {account && !wrongChain && (
                  <div className="wallet-table">
                    <Metric label="wallet" value={shortAddress(account)} />
                    <Metric
                      label={`${selectedRequest.token} balance`}
                      value={balances ? `${trimDisplay(balances.tokenBalance, 6)} ${selectedRequest.token}` : "loading"}
                    />
                    <Metric
                      label="gas balance"
                      value={balances ? `${trimDisplay(balances.nativeGas, 8)} USDC` : "loading"}
                    />
                    <Metric label="network" value="Arc Testnet" />
                  </div>
                )}
                {insufficientToken && (
                  <NoticeBar compact notice={{ tone: "error", text: `Insufficient ${selectedRequest.token} balance.` }} />
                )}

                <div className="action-row">
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={handleEstimate}
                    disabled={!account || wrongChain || isEstimating}
                  >
                    {isEstimating ? "Estimating..." : "Estimate"}
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={handlePay}
                    disabled={!account || wrongChain || insufficientToken || isPaying || selectedRequest.status === "paid"}
                  >
                    {isPaying ? "Paying..." : "Pay request"}
                  </button>
                  <button className="secondary-button" type="button" onClick={() => handleVerify(selectedRequest)} disabled={isVerifying}>
                    {isVerifying ? "Verifying..." : "Verify"}
                  </button>
                </div>

                {estimate && (
                  <div className="estimate-line">
                    <Metric label="estimated gas" value={estimate.gas.toString()} />
                    <Metric label="gas price" value={`${trimDisplay(formatUnits(estimate.gasPrice, 18), 8)} USDC`} />
                    <Metric label="estimated fee" value={`${trimDisplay(estimate.fee, 8)} USDC`} />
                  </div>
                )}

                {payNotice && <NoticeBar notice={payNotice} />}

                {selectedReceipt && (
                  <div className="receipt-line">
                    <div>
                      <span>Receipt</span>
                      <strong>{shortAddress(selectedReceipt.txHash, 10, 8)}</strong>
                    </div>
                    <a href={selectedReceipt.explorerUrl} target="_blank" rel="noreferrer">
                      Open tx
                    </a>
                  </div>
                )}
              </>
            ) : (
              <EmptyState title="No request selected" text="Create a request or import a ledger file to activate payment controls." />
            )}
          </section>
        </div>

        <div className="support-grid" aria-label="Payment utilities">
          <section className="support-pane">
            <PaneTitle label="Stablecoin rails" />
            <TokenLine token="USDC" decimals={rpcHealth?.usdcDecimals} />
            <TokenLine token="EURC" decimals={rpcHealth?.eurcDecimals} />
          </section>
          <section className="support-pane">
            <PaneTitle label="Files" />
            <div className="tool-actions">
              <button className="secondary-button" type="button" onClick={handleExport} disabled={!requests.length}>
                Export ledger
              </button>
              <button className="secondary-button" type="button" onClick={() => importInputRef.current?.click()}>
                Import ledger
              </button>
              <a className="secondary-button" href={ARC_EXPLORER_URL} target="_blank" rel="noreferrer">
                Arcscan
              </a>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="sr-only"
                onChange={(event) => handleImport(event.target.files?.[0])}
              />
            </div>
          </section>
        </div>
      </section>

      <section className="process-section" aria-label="Payment process">
        <header className="section-header">
          <h2>How verification works</h2>
        </header>
        <div className="process-list">
          <ProcessItem
            index="01"
            title="Request"
            text="The request URL carries recipient, token, amount, label, and the starting block."
          />
          <ProcessItem
            index="02"
            title="Pay"
            text="The payer switches to Arc Testnet and sends a direct USDC or EURC transfer."
          />
          <ProcessItem
            index="03"
            title="Verify"
            text="Disburse checks the receipt hash or scans Transfer logs for the exact match."
          />
        </div>
      </section>

      <section id="ledger" className="ledger-section">
        <header className="section-header inline-header">
          <div>
            <h2>Ledger</h2>
            <p>{requests.length} requests stored.</p>
          </div>
          <button className="secondary-button" type="button" onClick={() => importInputRef.current?.click()}>
            Import
          </button>
        </header>

        {requests.length ? (
          <div className="ledger-list">
            {requests.map((request) => {
              const receipt = receipts.find((item) => item.requestId === request.id);
              const requestUrl = buildShareUrl(request, window.location.origin);
              return (
                <article className={`ledger-row ${request.id === selectedRequest?.id ? "selected" : ""}`} key={request.id}>
                  <button type="button" className="ledger-main" onClick={() => handleSelectRequest(request)}>
                    <StatusBadge status={request.status} />
                    <div>
                      <strong>{request.label}</strong>
                      <span>
                        {request.amount} {request.token} to {shortAddress(request.recipient)}
                      </span>
                    </div>
                  </button>
                  <div className="ledger-meta">
                    <span>{new Date(request.createdAt).toLocaleDateString()}</span>
                    <span>block {request.startBlock}</span>
                  </div>
                  <div className="ledger-actions">
                    <button className="text-button" type="button" onClick={() => copyValue(requestUrl, setCreateNotice)}>
                      Copy
                    </button>
                    <button className="text-button" type="button" onClick={() => handleVerify(request)}>
                      Verify
                    </button>
                    {receipt && (
                      <a className="text-button" href={receipt.explorerUrl} target="_blank" rel="noreferrer">
                        Receipt
                      </a>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState title="Ledger is empty" text="Created and imported requests appear here." />
        )}
      </section>

      <FAQSection />
      <SiteFooter onNavigate={handleNavigate} />
    </main>
  );
}

function TopNav({
  page,
  theme,
  account,
  chainId,
  isConnecting,
  onConnect,
  onSwitch,
  onNavigate,
  onToggleTheme
}: {
  page: Page;
  theme: Theme;
  account?: string;
  chainId?: number;
  isConnecting: boolean;
  onConnect: () => void;
  onSwitch: () => void;
  onNavigate: NavigateHandler;
  onToggleTheme: () => void;
}) {
  return (
    <nav className="top-nav" aria-label="Primary">
      <a className="brand" href="/#top" onClick={(event) => onNavigate(event, "/#top")} aria-label="Disburse home">
        <img src="/disburse-logo.png" alt="" aria-hidden="true" />
        <strong>Disburse</strong>
      </a>
      <div className="nav-links">
        <a
          href="/#console"
          onClick={(event) => onNavigate(event, "/#console")}
        >
          Pay
        </a>
        <a
          className={page === "docs" ? "active" : ""}
          href="/docs"
          onClick={(event) => onNavigate(event, "/docs")}
          aria-current={page === "docs" ? "page" : undefined}
        >
          Docs
        </a>
      </div>
      <div className="nav-actions">
        <a className="text-link" href={ARC_FAUCET_URL} target="_blank" rel="noreferrer">
          Faucet
        </a>
        <WalletPill
          account={account}
          chainId={chainId}
          isConnecting={isConnecting}
          onConnect={onConnect}
          onSwitch={onSwitch}
        />
        <button
          className="theme-toggle"
          type="button"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          aria-pressed={theme === "dark"}
        >
          <span className="theme-toggle-track" aria-hidden="true">
            <span className="theme-toggle-knob" />
          </span>
          <span className="theme-toggle-label">{theme === "dark" ? "Dark" : "Light"}</span>
        </button>
      </div>
    </nav>
  );
}

function DocsPage() {
  return (
    <>
      <section className="docs-hero" aria-label="Documentation">
        <p className="eyebrow">Documentation</p>
        <p>
          Chain configuration, payload structure, transaction execution, and verification boundaries for the local
          Arc Testnet payment console.
        </p>
      </section>

      <section className="docs-manual" aria-label="Documentation sections">
        <div className="docs-content">
          {docsSections.map((section, index) => (
            <article
              className="docs-section"
              id={slugify(section.title)}
              key={section.title}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h2>{section.title}</h2>
                <p>{section.body}</p>
                {section.points && (
                  <ul>
                    {section.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                )}
                {section.code && <code>{section.code}</code>}
              </div>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function slugify(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
}

function FAQSection() {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <section id="faq" className="faq-section" aria-labelledby="faq-heading">
      <header className="section-header">
        <h2 id="faq-heading">FAQ</h2>
      </header>
      <div className="faq-list">
        {faqItems.map((item, index) => (
          <article className={`faq-item ${openIndex === index ? "open" : ""}`} key={item.question}>
            <button
              className="faq-trigger"
              type="button"
              aria-expanded={openIndex === index}
              aria-controls={`faq-answer-${index}`}
              onClick={() => setOpenIndex((current) => (current === index ? -1 : index))}
            >
              <span>{item.question}</span>
            </button>
            <div className="faq-answer" id={`faq-answer-${index}`}>
              <div>
                <p>{item.answer}</p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SiteFooter({ onNavigate }: { onNavigate: NavigateHandler }) {
  return (
    <footer className="site-footer">
      <strong>Disburse</strong>
      <nav aria-label="Footer">
        <a href="/docs" onClick={(event) => onNavigate(event, "/docs")}>
          Docs
        </a>
        <a href={ARC_DOCS_URL} target="_blank" rel="noreferrer">
          Arc docs
        </a>
      </nav>
    </footer>
  );
}

function WalletPill({
  account,
  chainId,
  isConnecting,
  onConnect,
  onSwitch
}: {
  account?: string;
  chainId?: number;
  isConnecting: boolean;
  onConnect: () => void;
  onSwitch: () => void;
}) {
  if (!account) {
    return (
      <button className="wallet-pill" type="button" onClick={onConnect} disabled={isConnecting}>
        {isConnecting ? "Connecting..." : "Connect"}
      </button>
    );
  }

  if (chainId !== ARC_CHAIN_ID) {
    return (
      <button className="wallet-pill warning" type="button" onClick={onSwitch} disabled={isConnecting}>
        Wrong chain
      </button>
    );
  }

  return <span className="wallet-pill connected">{shortAddress(account)}</span>;
}

function Field({
  label,
  helper,
  children
}: {
  label: string;
  helper?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {helper && <small>{helper}</small>}
    </label>
  );
}

function PaneTitle({ id, label }: { id?: string; label: string }) {
  return (
    <div className="pane-title">
      <h3 id={id}>{label}</h3>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TokenLine({ token, decimals }: { token: PaymentToken; decimals?: number }) {
  return (
    <div className="token-line">
      <div>
        <strong>{token}</strong>
        <span>{TOKENS[token].label}</span>
      </div>
      <code>{shortAddress(TOKENS[token].address)}</code>
      <small>{decimals ?? "pending"} decimals</small>
    </div>
  );
}

function StatusBadge({ status }: { status: PaymentStatus }) {
  return <span className={`status-badge ${status}`}>{status.replace("_", " ")}</span>;
}

function NoticeBar({ notice, compact = false }: { notice: Notice; compact?: boolean }) {
  return (
    <div className={`notice ${notice.tone} ${compact ? "compact" : ""}`}>
      <span>{notice.text}</span>
    </div>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty-state">
      <strong>{title}</strong>
      <span>{text}</span>
    </div>
  );
}

function ProcessItem({ index, title, text }: { index: string; title: string; text: string }) {
  return (
    <article className="process-item">
      <span>{index}</span>
      <h3>{title}</h3>
      <p>{text}</p>
    </article>
  );
}

function trimDisplay(value: string, maxDecimals: number): string {
  const [whole, fraction] = value.split(".");
  if (!fraction) {
    return whole;
  }
  const trimmed = fraction.slice(0, maxDecimals).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

export default App;
