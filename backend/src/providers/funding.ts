import {
  createPublicClient,
  erc20Abi,
  getAddress,
  type Hex,
  http,
  parseEventLogs,
  type TransactionReceipt,
} from "viem";
import type { FundingConfiguration } from "../domain.js";
import { HttpError } from "../errors.js";

export type DepositInspection =
  | { status: "pending"; confirmations: number }
  | { status: "failed"; confirmations: number; reason: string }
  | {
      status: "confirmed";
      confirmations: number;
      amountAtomic: bigint;
      amountMinor: number;
      blockNumber: bigint;
    };

export interface FundingProvider {
  readonly mode: "chain" | "disabled";
  configuration(): FundingConfiguration;
  inspectDeposit(txHash: string, sourceAddress: string): Promise<DepositInspection>;
}

export interface ChainFundingOptions {
  walletAddress: string;
  tokenAddress: string;
  tokenDecimals: number;
  chainId: number;
  networkName: string;
  rpcUrl: string;
  explorerUrl: string;
  requiredConfirmations: number;
}

export interface FundingChainClient {
  getChainId(): Promise<number>;
  getTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt>;
  getBlockNumber(): Promise<bigint>;
}

/** Reads the public chain only. It never receives or uses Happy's spending key. */
export class ChainFundingProvider implements FundingProvider {
  readonly mode = "chain" as const;
  private readonly client: FundingChainClient;
  private readonly walletAddress: `0x${string}`;
  private readonly tokenAddress: `0x${string}`;

  constructor(
    private readonly options: ChainFundingOptions,
    client?: FundingChainClient,
  ) {
    this.walletAddress = getAddress(options.walletAddress);
    this.tokenAddress = getAddress(options.tokenAddress);
    this.client = client ?? createPublicClient({ transport: http(options.rpcUrl) });
  }

  configuration(): FundingConfiguration {
    return {
      enabled: true,
      mode: "chain",
      walletAddress: this.walletAddress,
      tokenAddress: this.tokenAddress,
      tokenSymbol: "XSGD",
      tokenDecimals: this.options.tokenDecimals,
      chainId: this.options.chainId,
      networkName: this.options.networkName,
      rpcUrl: this.options.rpcUrl,
      explorerUrl: this.options.explorerUrl.replace(/\/$/, ""),
      requiredConfirmations: this.options.requiredConfirmations,
    };
  }

  async inspectDeposit(txHash: string, sourceAddress: string): Promise<DepositInspection> {
    const liveChainId = await this.client.getChainId();
    if (liveChainId !== this.options.chainId) {
      throw new HttpError(
        502,
        `Funding RPC is connected to chain ${liveChainId}, expected ${this.options.chainId}.`,
      );
    }

    let receipt: TransactionReceipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash as Hex });
    } catch (error) {
      if ((error as { name?: string }).name === "TransactionReceiptNotFoundError") {
        return { status: "pending", confirmations: 0 };
      }
      throw error;
    }

    const latestBlock = await this.client.getBlockNumber();
    const confirmations = Number(latestBlock - receipt.blockNumber + 1n);
    const fail = (reason: string): DepositInspection => ({
      status: "failed",
      confirmations,
      reason,
    });

    if (receipt.status !== "success") return fail("The transfer transaction reverted.");
    if (receipt.from.toLowerCase() !== getAddress(sourceAddress).toLowerCase()) {
      return fail("The transaction sender does not match the connected wallet.");
    }
    if (receipt.to?.toLowerCase() !== this.tokenAddress.toLowerCase()) {
      return fail("The transaction was not sent to the configured XSGD contract.");
    }

    const transfers = parseEventLogs({
      abi: erc20Abi,
      eventName: "Transfer",
      logs: receipt.logs,
      strict: true,
    }).filter(
      (log) =>
        log.address.toLowerCase() === this.tokenAddress.toLowerCase() &&
        log.args.from?.toLowerCase() === getAddress(sourceAddress).toLowerCase() &&
        log.args.to?.toLowerCase() === this.walletAddress.toLowerCase(),
    );
    if (transfers.length !== 1) {
      return fail("No single XSGD transfer from the connected wallet to Happy was found.");
    }

    const amountAtomic = transfers[0]?.args.value;
    if (typeof amountAtomic !== "bigint" || amountAtomic <= 0n) {
      return fail("The XSGD transfer amount is invalid.");
    }
    const centsScale = 10n ** BigInt(this.options.tokenDecimals - 2);
    if (amountAtomic % centsScale !== 0n) {
      return fail("Happy deposits must use whole SGD cents.");
    }
    const amountMinorBigInt = amountAtomic / centsScale;
    if (amountMinorBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
      return fail("The XSGD transfer amount is too large to credit safely.");
    }
    if (confirmations < this.options.requiredConfirmations) {
      return { status: "pending", confirmations };
    }
    return {
      status: "confirmed",
      confirmations,
      amountAtomic,
      amountMinor: Number(amountMinorBigInt),
      blockNumber: receipt.blockNumber,
    };
  }
}

export class DisabledFundingProvider implements FundingProvider {
  readonly mode = "disabled" as const;

  configuration(): FundingConfiguration {
    return {
      enabled: false,
      mode: "disabled",
      message: "XSGD funding is not configured on this backend.",
    };
  }

  async inspectDeposit(): Promise<DepositInspection> {
    throw new HttpError(503, "XSGD funding is not configured on this backend.");
  }
}
