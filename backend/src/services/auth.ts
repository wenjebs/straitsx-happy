import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { HttpError } from "../errors.js";

const scrypt = promisify(scryptCallback);

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  initials: string;
  createdAt: string;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt: string;
}

export interface SignupResult {
  confirmationRequired: boolean;
  email: string;
  session?: AuthSession | undefined;
}

export interface AuthService {
  readonly mode: "disabled" | "local" | "cognito";
  signup(name: string, email: string, password: string): Promise<SignupResult>;
  confirmSignup(email: string, code: string): Promise<void>;
  login(email: string, password: string): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  authenticate(authorization: string | undefined): Promise<AuthUser>;
}

interface LocalUser extends AuthUser {
  passwordHash: string;
}

interface LocalSessionPayload {
  type: "auth";
  user: AuthUser;
  expiresAt: number;
  nonce: string;
}

export class LocalAuthService implements AuthService {
  readonly mode = "local" as const;
  private readonly users = new Map<string, LocalUser>();

  constructor(private readonly secret: string) {}

  async signup(name: string, rawEmail: string, password: string): Promise<SignupResult> {
    const email = normalizeEmail(rawEmail);
    assertPassword(password);
    if (this.users.has(email)) {
      throw new HttpError(409, "An account with this email already exists.");
    }
    const user: LocalUser = {
      id: `usr_${randomBytes(16).toString("hex")}`,
      email,
      name: normalizeName(name),
      initials: initials(name),
      createdAt: new Date().toISOString(),
      passwordHash: await hashPassword(password),
    };
    this.users.set(email, user);
    return { confirmationRequired: false, email, session: this.session(user) };
  }

  async confirmSignup(): Promise<void> {
    throw new HttpError(409, "Local accounts do not require email confirmation.");
  }

  async login(rawEmail: string, password: string): Promise<AuthSession> {
    const user = this.users.get(normalizeEmail(rawEmail));
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, "Email or password is incorrect.");
    }
    return this.session(user);
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const user = this.read(refreshToken).user;
    return this.session(user);
  }

  async authenticate(authorization: string | undefined): Promise<AuthUser> {
    return this.read(bearerToken(authorization)).user;
  }

  private session(user: AuthUser): AuthSession {
    const expiresAt = Date.now() + 7 * 24 * 60 * 60_000;
    const accessToken = this.sign({
      type: "auth",
      user,
      expiresAt,
      nonce: randomBytes(16).toString("hex"),
    });
    return {
      user,
      accessToken,
      refreshToken: accessToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  private sign(payload: LocalSessionPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.secret).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private read(token: string): LocalSessionPayload {
    const [encoded, supplied] = token.split(".");
    if (!encoded || !supplied) throw new HttpError(401, "Login required.");
    const expected = createHmac("sha256", this.secret).update(encoded).digest();
    const actual = Buffer.from(supplied, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new HttpError(401, "Login session is invalid.");
    }
    let payload: LocalSessionPayload;
    try {
      payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as LocalSessionPayload;
    } catch {
      throw new HttpError(401, "Login session is invalid.");
    }
    if (
      payload.type !== "auth" ||
      payload.expiresAt <= Date.now() ||
      !payload.user?.id ||
      !payload.user.email
    ) {
      throw new HttpError(401, "Login session has expired.");
    }
    return payload;
  }
}

export class DisabledAuthService implements AuthService {
  readonly mode = "disabled" as const;
  private readonly user: AuthUser = {
    id: "demo-user",
    email: "demo@happy.local",
    name: "Happy Demo",
    initials: "HD",
    createdAt: new Date("2026-08-01T00:00:00.000Z").toISOString(),
  };

  async signup(): Promise<SignupResult> {
    return {
      confirmationRequired: false,
      email: this.user.email,
      session: await this.login(),
    };
  }

  async confirmSignup(): Promise<void> {}

  async login(): Promise<AuthSession> {
    return {
      user: this.user,
      accessToken: "auth-disabled",
      refreshToken: "auth-disabled",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString(),
    };
  }

  async refresh(): Promise<AuthSession> {
    return this.login();
  }

  async authenticate(_authorization: string | undefined): Promise<AuthUser> {
    return this.user;
  }
}

export class CognitoAuthService implements AuthService {
  readonly mode = "cognito" as const;
  private readonly client: CognitoIdentityProviderClient;
  private readonly verifier: ReturnType<typeof CognitoJwtVerifier.create>;

  constructor(
    userPoolId: string,
    private readonly clientId: string,
    region: string,
  ) {
    this.client = new CognitoIdentityProviderClient({ region });
    this.verifier = CognitoJwtVerifier.create({
      userPoolId,
      clientId,
      tokenUse: "id",
    });
  }

  async signup(name: string, rawEmail: string, password: string): Promise<SignupResult> {
    const email = normalizeEmail(rawEmail);
    assertPassword(password);
    try {
      const result = await this.client.send(
        new SignUpCommand({
          ClientId: this.clientId,
          Username: email,
          Password: password,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "name", Value: normalizeName(name) },
          ],
        }),
      );
      return { confirmationRequired: !result.UserConfirmed, email };
    } catch (error) {
      throw cognitoError(error);
    }
  }

  async confirmSignup(rawEmail: string, code: string): Promise<void> {
    try {
      await this.client.send(
        new ConfirmSignUpCommand({
          ClientId: this.clientId,
          Username: normalizeEmail(rawEmail),
          ConfirmationCode: code.trim(),
        }),
      );
    } catch (error) {
      throw cognitoError(error);
    }
  }

  async login(rawEmail: string, password: string): Promise<AuthSession> {
    try {
      const result = await this.client.send(
        new InitiateAuthCommand({
          ClientId: this.clientId,
          AuthFlow: "USER_PASSWORD_AUTH",
          AuthParameters: { USERNAME: normalizeEmail(rawEmail), PASSWORD: password },
        }),
      );
      return this.cognitoSession(
        result.AuthenticationResult?.IdToken,
        result.AuthenticationResult?.RefreshToken,
      );
    } catch (error) {
      throw cognitoError(error);
    }
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    try {
      const result = await this.client.send(
        new InitiateAuthCommand({
          ClientId: this.clientId,
          AuthFlow: "REFRESH_TOKEN_AUTH",
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        }),
      );
      return this.cognitoSession(result.AuthenticationResult?.IdToken, refreshToken);
    } catch (error) {
      throw cognitoError(error);
    }
  }

  async authenticate(authorization: string | undefined): Promise<AuthUser> {
    const token = bearerToken(authorization);
    try {
      const payload = await this.verifier.verify(token);
      return userFromCognitoPayload(payload);
    } catch {
      throw new HttpError(401, "Login session is invalid or expired.");
    }
  }

  private async cognitoSession(
    idToken: string | undefined,
    refreshToken: string | undefined,
  ): Promise<AuthSession> {
    if (!idToken) throw new HttpError(502, "Cognito did not return an ID token.");
    const payload = await this.verifier.verify(idToken);
    return {
      user: userFromCognitoPayload(payload),
      accessToken: idToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresAt: new Date(Number(payload.exp) * 1000).toISOString(),
    };
  }
}

function userFromCognitoPayload(payload: Record<string, unknown>): AuthUser {
  const id = String(payload.sub ?? "");
  const email = String(payload.email ?? "");
  const name = String(payload.name ?? email.split("@")[0] ?? "Happy user");
  if (!id || !email) throw new HttpError(401, "Cognito identity is missing required claims.");
  return {
    id,
    email,
    name,
    initials: initials(name),
    createdAt: new Date(
      Number(payload.auth_time ?? payload.iat ?? Date.now() / 1000) * 1000,
    ).toISOString(),
  };
}

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Login required.");
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) throw new HttpError(401, "Login required.");
  return token;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeName(name: string): string {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > 80) {
    throw new HttpError(422, "Name must be between 2 and 80 characters.");
  }
  return normalized;
}

function initials(name: string): string {
  const parts = normalizeName(name).split(" ");
  return `${parts[0]?.[0] ?? "H"}${parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : ""}`.toUpperCase();
}

function assertPassword(password: string): void {
  if (
    password.length < 8 ||
    password.length > 128 ||
    !/[a-z]/.test(password) ||
    !/[A-Z]/.test(password) ||
    !/\d/.test(password)
  ) {
    throw new HttpError(
      422,
      "Password must be 8–128 characters and include uppercase, lowercase, and a number.",
    );
  }
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, encodedSalt, encodedHash] = stored.split("$");
  if (kind !== "scrypt" || !encodedSalt || !encodedHash) return false;
  const expected = Buffer.from(encodedHash, "base64url");
  const actual = (await scrypt(
    password,
    Buffer.from(encodedSalt, "base64url"),
    expected.length,
  )) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function cognitoError(error: unknown): HttpError {
  const name = error instanceof Error ? error.name : "";
  if (name === "UsernameExistsException") {
    return new HttpError(409, "An account with this email already exists.");
  }
  if (name === "UserNotConfirmedException") {
    return new HttpError(403, "Confirm your email before signing in.");
  }
  if (name === "NotAuthorizedException" || name === "UserNotFoundException") {
    return new HttpError(401, "Email or password is incorrect.");
  }
  if (name === "CodeMismatchException" || name === "ExpiredCodeException") {
    return new HttpError(422, "The confirmation code is invalid or expired.");
  }
  if (name === "InvalidPasswordException") {
    return new HttpError(422, "Password does not meet the account security requirements.");
  }
  return new HttpError(502, "Authentication provider is temporarily unavailable.");
}
