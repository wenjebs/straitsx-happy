import type { AddressInfo } from "node:net";
import { startPurchaseService } from "./index.js";
import { stopAllBrowsers } from "./server.js";

const server = await startPurchaseService();
const addr = server.address() as AddressInfo | null;
console.log(`closer purchase service  http://127.0.0.1:${addr?.port ?? "?"}`);
console.log(`browser                  ${process.env.CLOSER_BROWSER ?? "local"}`);

/*
 * Ctrl-C must not leave browsers running.
 *
 * An AgentCore session bills until it is stopped and its TTL is half an hour, so killing this
 * process mid-run used to abandon every browser it held — ten of them were found still billing
 * after one afternoon. `runPurchase` releases its own browser when a run ends normally; this is
 * for the runs that never get to end.
 */
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nstopping browsers…");
    void stopAllBrowsers()
      .then((n) => console.log(`stopped ${n} browser(s)`))
      .catch((e) => console.error("browser cleanup failed:", (e as Error).message))
      .finally(() => process.exit(0));
  });
}
