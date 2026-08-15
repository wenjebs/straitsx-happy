import type { MerchantAdapter } from "../types.js";

const HOSTS = new Set(["127.0.0.1", "localhost"]);

export const demoStoreAdapter: MerchantAdapter = {
  name: "demo-store",
  matches: (url) => HOSTS.has(url.hostname),
  async toPaymentPage() {},
  async readFinalTotalCents() {
    throw new Error("not implemented until task 8");
  },
};
