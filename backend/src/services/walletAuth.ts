import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getAddress, type Hex, verifyMessage } from "viem";
import { HttpError } from "../errors.js";

interface SignedPayload {
  type: "challenge" | "session";
  userId: string;
  address: string;
  nonce: string;
  expiresAt: number;
}

export interface WalletIdentity {
  userId: string;
  address: string;
}

export class WalletAuthService {
  constructor(private readonly secret: string | undefined) {}

  challenge(
    userId: string,
    address: string,
  ): { challengeToken: string; message: string; expiresAt: string } {
    this.configuredSecret();
    const normalized = getAddress(address).toLowerCase();
    const payload: SignedPayload = {
      type: "challenge",
      userId,
      address: normalized,
      nonce: randomBytes(16).toString("hex"),
      expiresAt: Date.now() + 5 * 60_000,
    };
    return {
      challengeToken: this.sign(payload),
      message: challengeMessage(payload),
      expiresAt: new Date(payload.expiresAt).toISOString(),
    };
  }

  async verify(
    userId: string,
    challengeToken: string,
    signature: string,
  ): Promise<{ sessionToken: string; address: string; expiresAt: string }> {
    const challenge = this.read(challengeToken, "challenge");
    if (challenge.userId !== userId) {
      throw new HttpError(403, "Wallet challenge belongs to a different Happy account.");
    }
    const valid = await verifyMessage({
      address: challenge.address as `0x${string}`,
      message: challengeMessage(challenge),
      signature: signature as Hex,
    }).catch(() => false);
    if (!valid) throw new HttpError(401, "Wallet signature could not be verified.");
    const session: SignedPayload = {
      type: "session",
      userId,
      address: challenge.address,
      nonce: randomBytes(16).toString("hex"),
      expiresAt: Date.now() + 24 * 60 * 60_000,
    };
    return {
      sessionToken: this.sign(session),
      address: session.address,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  }

  identity(token: string | undefined, required: boolean): WalletIdentity | null {
    if (!token) {
      if (required) throw new HttpError(401, "Connect and authorize your wallet first.");
      return null;
    }
    try {
      const session = this.read(
        token.startsWith("Bearer ") ? token.slice("Bearer ".length) : token,
        "session",
      );
      return { userId: session.userId, address: session.address };
    } catch (error) {
      if (required) throw error;
      return null;
    }
  }

  private sign(payload: SignedPayload): string {
    const secret = this.configuredSecret();
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private read(token: string, expectedType: SignedPayload["type"]): SignedPayload {
    const secret = this.configuredSecret();
    const [encoded, supplied] = token.split(".");
    if (!encoded || !supplied) throw new HttpError(401, "Wallet authorization is invalid.");
    const expected = createHmac("sha256", secret).update(encoded).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(supplied, "base64url");
    } catch {
      throw new HttpError(401, "Wallet authorization is invalid.");
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpError(401, "Wallet authorization is invalid.");
    }
    let payload: SignedPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SignedPayload;
    } catch {
      throw new HttpError(401, "Wallet authorization is invalid.");
    }
    if (payload.type !== expectedType || payload.expiresAt <= Date.now()) {
      throw new HttpError(401, "Wallet authorization has expired.");
    }
    if (
      !payload.userId ||
      payload.userId.length > 200 ||
      !/^0x[0-9a-f]{40}$/.test(payload.address) ||
      !/^[0-9a-f]{32}$/.test(payload.nonce)
    ) {
      throw new HttpError(401, "Wallet authorization is invalid.");
    }
    return payload;
  }

  private configuredSecret(): string {
    if (!this.secret) throw new HttpError(503, "Wallet authorization is not configured.");
    return this.secret;
  }
}

function challengeMessage(payload: SignedPayload): string {
  return [
    "Authorize this wallet for Happy funding",
    "",
    `Address: ${payload.address}`,
    `Happy account: ${payload.userId}`,
    `Nonce: ${payload.nonce}`,
    `Expires: ${new Date(payload.expiresAt).toISOString()}`,
    "",
    "This request proves wallet ownership. It does not authorize spending.",
  ].join("\n");
}
