import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { avalanche, avalancheFuji } from "wagmi/chains";
import { http } from "wagmi";
import { FUJI_RPC } from "@happy/shared";

/**
 * The user's own key lives in their wallet extension and never leaves it. The
 * frontend only ever asks it to `signTypedData` — the AP2 mandate JWT and the
 * ZeroDev session-key approval. It never holds a private key. DESIGN.md §5.
 */
export const config = getDefaultConfig({
  appName: "Happy",
  // Fine to ship publicly — it is an origin-scoped project id, not a secret.
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? "happy-dev",
  chains: [avalancheFuji, avalanche],
  transports: {
    [avalancheFuji.id]: http(FUJI_RPC),
    [avalanche.id]: http(),
  },
  ssr: false,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
