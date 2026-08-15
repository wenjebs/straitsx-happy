/** Constants that must match across api, web and demo-store. */

export const FUJI_CHAIN_ID = 43113;
export const AVALANCHE_CHAIN_ID = 43114;

/** lowercase on purpose — viem rejects a malformed EIP-55 checksum. */
export const XSGD_FUJI = "0xd769410dc8772695a7f55a304d2125320a65c2a5" as const;
export const XSGD_MAINNET = "0xb2f85b7ab3c2b6f62df06de6ae7d09c010a5096e" as const;

export const FUJI_RPC = "https://api.avax-test.network/ext/bc/C/rpc";
export const FUJI_EXPLORER = "https://testnet.snowtrace.io";
