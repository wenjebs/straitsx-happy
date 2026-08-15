import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useQuery } from "@tanstack/react-query";
import type { HealthResponse } from "@happy/shared";

/** Proxied to mandate-svc :8787 by vite.config.ts, so no CORS setup needed. */
async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/v1/health");
  if (!res.ok) throw new Error(`health ${res.status}`);
  return res.json();
}

export function App() {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth, retry: false });

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 p-8 text-neutral-100">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Happy</h1>
        <ConnectButton />
      </header>

      <section className="rounded-xl border border-neutral-800 p-5">
        <h2 className="mb-3 text-sm font-medium text-neutral-400">mandate-svc</h2>
        {health.isPending && <p className="text-neutral-500">checking…</p>}
        {health.isError && (
          <p className="text-red-400">
            unreachable — is <code>pnpm dev:api</code> running on :8787?
          </p>
        )}
        {health.data && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="text-neutral-500">issuer</dt>
            <dd>{health.data.issuer}</dd>
            <dt className="text-neutral-500">chain</dt>
            <dd>{health.data.chainId}</dd>
            <dt className="text-neutral-500">blockers</dt>
            <dd className={health.data.blockers.length ? "text-amber-400" : "text-emerald-400"}>
              {health.data.blockers.length ? health.data.blockers.join(", ") : "none"}
            </dd>
          </dl>
        )}
      </section>

      {/*
        Screens land here as the build plan progresses:
          - Mandate builder  → signTypedData: AP2 JWT + ZeroDev session key
          - Wallet balance   → XSGD on the Kernel account
          - Activity feed    → purchases, cards, settlement state
          - Footer string    → rendered verbatim from GET /v1/mandates/active
      */}
    </main>
  );
}
