# Cross-Chain QR Contracts

`QrPaymentSource` is deployed on Base Sepolia and Monad Testnet. It escrows the payer's ERC-20 and emits `QrPaymentInitiated`, which is the event Polymer proves. The owner can sweep escrowed source-chain funds for treasury rebalancing.

`QrPaymentSettlement` is deployed on Arc Testnet. It uses Polymer testnet `CrossL2ProverV2`, authorizes Base/Monad source contracts, maps source tokens to Arc USDC, prevents replay, and transfers prefunded Arc liquidity to the QR recipient.

Deployment checklist:

1. Deploy `QrPaymentSource` to Base Sepolia and Monad Testnet.
2. Deploy `QrPaymentSettlement` to Arc Testnet with prover `0x03Fb5bFA4EB2Cba072A477A372bB87880A60fC96`.
3. On the Arc settlement contract, call `setAllowedSource(sourceChainId, sourceContract, true)` for Base and Monad.
4. On the Arc settlement contract, call `setTokenRoute(sourceChainId, sourceToken, arcUsdcToken)`.
5. Prefund the Arc settlement contract with Arc USDC.
6. Put contract and token addresses into the app and server environment variables from `.env.example`.

For the current MegaETH-to-Monad migration, do not redeploy Base or Arc. Use the Monad-only route setup mode, which deploys a Monad `QrPaymentSource`, configures the existing Arc settlement contract, and disables the old MegaETH source authorization:

The repo includes a deploy helper:

```bash
npm run deploy:qr-contracts -- --compile-only
npm run deploy:qr-contracts -- --add-monad-source
```

Use `npm run deploy:qr-contracts -- --full` only when intentionally deploying a fresh Arc/Base/Monad contract set.

It reads `QR_DEPLOYER_PRIVATE_KEY`, source token addresses, and optional RPC overrides from local env files or the process environment. The helper writes deployment metadata to `deployments/` and public contract env output to `.env.qr-contracts.generated`.
