import { createPublicClient, erc20Abi, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Cents, Config } from "./config.js";

const AUTH_ABI = parseAbi(["function authorizationState(address,bytes32) view returns (bool)"]);

export type ChainView = { balanceCents: Cents; ageMs: number };

export function makeWallet(cfg: Config) {
  // Mock mode is defined by cfg.issuer, not merely by whether a key happens to be set — a key
  // left over from rehearsal in .env must not make an offline (ISSUER=mock) demo spend against
  // the real chain balance. index.ts's own mock-ness check (`cfg.issuer === 'mock' || !cfg.spendPrivateKey`)
  // must agree with this.
  const account =
    cfg.issuer === "straitsx" && cfg.spendPrivateKey
      ? privateKeyToAccount(cfg.spendPrivateKey)
      : null;
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  let cache: { cents: Cents; at: number } = { cents: 0, at: 0 };
  let timer: NodeJS.Timeout | null = null;

  async function refresh(): Promise<Cents> {
    if (!account) return 0;
    const atomic = (await client.readContract({
      address: cfg.xsgdAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    })) as bigint;
    cache = { cents: Number(atomic / 10_000n), at: Date.now() };
    return cache.cents;
  }

  return {
    account,
    address: account?.address ?? "0x0000000000000000000000000000000000000000",
    refresh,
    view(): ChainView {
      // With no key configured (mock mode) the balance is not a constraint.
      if (!account) return { balanceCents: Number.MAX_SAFE_INTEGER, ageMs: 0 };
      return {
        balanceCents: cache.cents,
        ageMs: cache.at === 0 ? Number.MAX_SAFE_INTEGER : Date.now() - cache.at,
      };
    },
    async authorizationUsed(nonce: `0x${string}`): Promise<boolean> {
      if (!account) return false;
      return (await client.readContract({
        address: cfg.xsgdAddress,
        abi: AUTH_ABI,
        functionName: "authorizationState",
        args: [account.address, nonce],
      })) as boolean;
    },
    start() {
      if (timer) return;
      void refresh().catch(() => {});
      timer = setInterval(() => void refresh().catch(() => {}), 5_000);
      timer.unref?.(); // never hold a test worker or CLI process open
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export type Wallet = ReturnType<typeof makeWallet>;
