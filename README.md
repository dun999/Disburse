# Disburse

Disburse is a client-side Arc Testnet payment console for wallet-signed stablecoin transfers.

It supports two current flows:

- **Payments**: send USDC or EURC directly from the connected wallet to a recipient address.
- **QR Payments**: create a fixed wallet payment request, share it as a QR code, let another wallet pay it, verify the on-chain transfer, and generate a PDF invoice.


## Stack

- Vite
- React 19
- TypeScript
- Supabase Realtime for cross-device QR payment status updates
- viem for wallet/RPC/contract calls
- qrcode for QR image generation
- pdf-lib for local invoice PDFs
- Vitest for unit tests

## Scripts

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

The dev server runs with `vite --host 0.0.0.0`. Vercel-style single page app routing is handled by `vercel.json`, which rewrites all paths to `index.html`.

For Supabase-backed QR realtime and API routes, run the app through Vercel locally or deploy it to Vercel so `/api/*` functions are available. Plain Vite dev still supports the previous local-only QR fallback.

Required realtime environment variables:

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

Apply `supabase/migrations/202604300001_qr_realtime.sql` to create the payment request, receipt, and realtime event tables before enabling the production realtime flow.

## Routes

- `/payments`: direct wallet transfer flow.
- `/qr-payments`: create, preview, export, import, and manage QR payment requests.
- `/pay?r=<payload>`: payer page opened from a QR code.
- `/docs`: in-app technical documentation for the current build.

## Network And Assets

Disburse is pinned to Arc Testnet.

- Chain ID: `5042002`
- Explorer: `https://testnet.arcscan.app`
- Faucet: `https://faucet.circle.com`
- Native gas symbol: `USDC` with 18 decimals
- ERC-20 USDC: `0x3600000000000000000000000000000000000000`
- ERC-20 EURC: `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`
- ERC-20 token decimals: `6`

RPC failover is configured across Arc public, Blockdaemon, dRPC, and QuickNode testnet endpoints. The app probes endpoint health and displays live block, safe gas, chain, RPC, and token decimal status.

## Wallet Flow

The app expects an injected EIP-1193 wallet.

1. `eth_requestAccounts` connects the wallet.
2. `wallet_switchEthereumChain` switches to Arc Testnet.
3. `wallet_addEthereumChain` is used as a fallback when Arc Testnet is not already known by the wallet.
4. Transfers submit `eth_sendTransaction` with ERC-20 `transfer(recipient, parsedAmount)` calldata.
5. viem estimates gas and applies the configured Arc gas-price floor.
6. The app saves the transaction hash as soon as the wallet returns it, then waits for one confirmation.

The app never receives private keys and does not custody funds.

## QR Payment Requests

A QR code contains a `/pay` URL with a base64url JSON payload in the `r` query parameter.

Current payload fields:

```ts
{
  version: 1,
  id: string,
  recipient: `0x${string}`,
  token: "USDC" | "EURC",
  amount: string,
  label: string,
  note?: string,
  invoiceDate?: string,
  expiresAt?: string,
  dueAt?: string,
  createdAt: string,
  startBlock: string
}
```

QR requests default to a 15 minute validity window. A payment attempt that starts before expiry can still be verified after the expiry timestamp.

The scanned payer page locks the request details. The payer can connect a wallet, estimate, send, verify, and download the invoice after payment.

When Supabase is configured, QR requests are also written through Vercel API functions. The payer reports submitted transaction hashes to `/api/qr-submissions`; after confirmation, `/api/qr-confirmations` verifies Arc Testnet logs and writes a realtime event. Requester screens subscribe to `payment_request_events`, so paid, failed, and expired states close the QR and replace it with a final status panel.

## Local Data

QR requests and receipts are stored in browser localStorage:

- `disburse.requests`
- `disburse.receipts`

Legacy keys are still read for migration:

- `arc-pay-desk.requests`
- `arc-pay-desk.receipts`

The QR ledger supports JSON export/import. Import recovery normalizes valid requests and receipts, drops malformed records, and regenerates receipt explorer URLs from Arcscan transaction hashes.

Direct Payments do not create QR request records. The page only keeps the latest direct transfer hash in the current browser session.

## Verification

Verification checks Arc Testnet ERC-20 `Transfer` logs.

If a request has a known transaction hash, Disburse reads that transaction receipt first. Otherwise it scans logs from the request `startBlock` to latest in 10,000-block windows.

Status rules:

- `paid`: exact transfer to the request recipient for the requested token amount.
- `failed`: submitted transaction reverted, did not pay the request, or paid the recipient with the wrong amount.
- `possible_match`: local log scan found a transfer to the recipient with a different amount before a submitted transaction was known.
- `open`: no matching transfer was found.
- `expired`: request is past its expiry and no pre-expiry payment attempt was submitted.

Receipts contain request id, transaction hash, payer, recipient, token, amount, block number, confirmation time, and Arcscan URL.

## Invoices

After successful verification, Disburse can generate a local PDF invoice with:

- request id
- label and note
- invoice date
- amount and token
- recipient and payer
- transaction hash
- block number
- confirmation time
- Arcscan link
- Arc Testnet chain id

Invoice files are generated in the browser. They are not uploaded or emailed by the app.
