/// <reference types="vite/client" />

import type { EthereumProvider } from "./lib/onchain";

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}
