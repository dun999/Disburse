# Disburse

Disburse is a local-first payment request console for Arc Testnet. It lets a merchant or operator create stablecoin payment requests, share payable links, connect an injected wallet, send USDC or EURC transfers, verify settlement from on-chain logs, and export or import the local ledger.

The app is fully client-side. It does not run a backend, custody funds, store private keys, or relay wallet signatures.

## Features

- Create payment requests with recipient, token, amount, label, optional note, and optional due date.
- Generate share links in the `/pay?r=...` format.
- Connect an injected EIP-1193 wallet and switch or add Arc Testnet.
- Show live Arc RPC health, gas price, token decimals, wallet gas balance, and token balance.
- Estimate and submit ERC-20 `transfer(recipient, amount)` transactions.
- Verify payment by receipt hash or by scanning matching `Transfer` logs from the request start block.
- Store requests and receipts in browser `localStorage`.
- Export and import the request and receipt ledger as JSON.
- Provide an in-app `/docs` page describing runtime, payload, execution, and verification boundaries.

## Tech Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS 4
- viem
- Vitest

## Prerequisites

- Node.js 20 or newer
- npm
- An injected wallet such as MetaMask or Rabby
- Arc Testnet funds for gas and test USDC/EURC payments

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Vite serves the app at:

```text
http://localhost:5173
```

If port `5173` is already in use, Vite will choose another available port.

## Available Scripts

```bash
npm run dev
```

Runs the Vite development server.

```bash
npm run typecheck
```

Runs TypeScript project checks without emitting files.

```bash
npm test
```

Runs the Vitest test suite once.

```bash
npm run build
```

Runs TypeScript checks and creates a production build in `dist/`.

```bash
npm run preview
```

Serves the production build locally.

## Arc Testnet Configuration

Network and token configuration lives in `src/lib/arc.ts`.

| Setting | Value |
| --- | --- |
| Chain | Arc Testnet |
| Chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.network` |
| Explorer | `https://testnet.arcscan.app` |
| Faucet | `https://faucet.circle.com` |
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |

Both supported ERC-20 payment tokens use 6 decimal places. Arc Testnet native gas is represented as USDC with 18 decimals.

## Payment Flow

1. Create a request with a recipient address, token, amount, label, and optional metadata.
2. Share the generated `/pay?r=...` link with the payer.
3. The payer connects a wallet and switches to Arc Testnet.
4. The app reads balances and estimates the ERC-20 transfer.
5. The payer signs and submits the transfer from their wallet.
6. The app verifies the transaction receipt or scans matching token transfer logs.
7. Verified receipts are saved to the browser ledger and linked to Arcscan.

## Persistence

Disburse stores data only in the current browser profile:

- `disburse.requests`
- `disburse.receipts`
- `disburse.theme`

Use the export and import controls before clearing site data or moving to another browser profile. There is no cloud sync in this build. Legacy `arc-pay-desk.*` browser storage keys are still read during migration.

## Deployment Notes

The app uses client-side routing for `/docs` and `/pay`. Static hosting should rewrite unknown paths back to `index.html` so shared payment links and documentation routes load correctly.

The current build has no required environment variables. Updating chain, RPC, explorer, or token addresses requires editing `src/lib/arc.ts`.

## Safety Notes

- This project is configured for Arc Testnet, not mainnet.
- Requests are encoded in share URLs and should not include sensitive notes.
- Verification confirms matching token transfers, but it is not a replacement for accounting controls, invoicing permissions, or backend reconciliation in production systems.
- Browser storage can be cleared by the user, browser, or device policies.
