import type { AddressInfo } from "node:net";
import { startPurchaseService } from "./index.js";

const server = await startPurchaseService();
const addr = server.address() as AddressInfo | null;
console.log(`closer purchase service  http://127.0.0.1:${addr?.port ?? "?"}`);
console.log(`browser                  ${process.env.CLOSER_BROWSER ?? "local"}`);
