import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { WalletAuthService } from "./walletAuth.js";

const account = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);

describe("wallet authorization", () => {
  it("binds the signed wallet proof to one authenticated Happy account", async () => {
    const service = new WalletAuthService("test-wallet-secret-that-is-long-enough");
    const challenge = service.challenge("user-a", account.address);
    const signature = await account.signMessage({ message: challenge.message });

    await expect(
      service.verify("user-b", challenge.challengeToken, signature),
    ).rejects.toMatchObject({
      status: 403,
    });

    const session = await service.verify("user-a", challenge.challengeToken, signature);
    expect(service.identity(session.sessionToken, true)).toEqual({
      userId: "user-a",
      address: account.address.toLowerCase(),
    });
  });
});
