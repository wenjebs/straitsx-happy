import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { describe, expect, it } from "vitest";
import { ChainFundingProvider, type FundingChainClient } from "./funding.js";

const happy = "0x1111111111111111111111111111111111111111" as const;
const token = "0x2222222222222222222222222222222222222222" as const;
const user = "0x3333333333333333333333333333333333333333" as const;
const hash = `0x${"ab".repeat(32)}`;

function receipt(overrides: Record<string, unknown> = {}): TransactionReceipt {
  return {
    status: "success",
    from: user,
    to: token,
    blockNumber: 100n,
    logs: [
      {
        address: token,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: "Transfer",
          args: { from: user, to: happy },
        }),
        data: encodeAbiParameters([{ type: "uint256" }], [25_000_000n]),
      },
    ],
    ...overrides,
  } as unknown as TransactionReceipt;
}

function provider(receiptValue = receipt()) {
  const client: FundingChainClient = {
    async getChainId() {
      return 43113;
    },
    async getTransactionReceipt(_args: { hash: Hex }) {
      return receiptValue;
    },
    async getBlockNumber() {
      return 101n;
    },
  };
  return new ChainFundingProvider(
    {
      walletAddress: happy,
      tokenAddress: token,
      tokenDecimals: 6,
      chainId: 43113,
      networkName: "Avalanche Fuji C-Chain",
      rpcUrl: "https://rpc.example",
      explorerUrl: "https://explorer.example",
      requiredConfirmations: 2,
    },
    client,
  );
}

describe("XSGD funding verification", () => {
  it("derives the credited cents from the confirmed Transfer event", async () => {
    await expect(provider().inspectDeposit(hash, user)).resolves.toEqual({
      status: "confirmed",
      confirmations: 2,
      amountAtomic: 25_000_000n,
      amountMinor: 2500,
      blockNumber: 100n,
    });
  });

  it("rejects a transaction sent by a different wallet", async () => {
    const result = await provider(
      receipt({ from: "0x4444444444444444444444444444444444444444" }),
    ).inspectDeposit(hash, user);
    expect(result).toEqual(
      expect.objectContaining({ status: "failed", reason: expect.stringContaining("sender") }),
    );
  });

  it("rejects a transaction sent to a different token contract", async () => {
    const result = await provider(
      receipt({ to: "0x4444444444444444444444444444444444444444" }),
    ).inspectDeposit(hash, user);
    expect(result).toEqual(
      expect.objectContaining({ status: "failed", reason: expect.stringContaining("XSGD") }),
    );
  });

  it("keeps a mined transfer pending until the confirmation threshold", async () => {
    const client: FundingChainClient = {
      async getChainId() {
        return 43113;
      },
      async getTransactionReceipt() {
        return receipt();
      },
      async getBlockNumber() {
        return 100n;
      },
    };
    const pending = new ChainFundingProvider(
      {
        walletAddress: happy,
        tokenAddress: token,
        tokenDecimals: 6,
        chainId: 43113,
        networkName: "Avalanche Fuji C-Chain",
        rpcUrl: "https://rpc.example",
        explorerUrl: "https://explorer.example",
        requiredConfirmations: 2,
      },
      client,
    );
    await expect(pending.inspectDeposit(hash, user)).resolves.toEqual({
      status: "pending",
      confirmations: 1,
    });
  });
});
