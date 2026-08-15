import { describe, expect, it } from "vitest";
import { LocalAuthService } from "./auth.js";

describe("local authentication", () => {
  it("creates an account, rejects a wrong password, and restores the signed session", async () => {
    const auth = new LocalAuthService("test-auth-secret-that-is-long-enough-for-hmac");
    const signup = await auth.signup("Ada Lovelace", "ADA@EXAMPLE.COM", "StrongPass1");

    expect(signup.confirmationRequired).toBe(false);
    expect(signup.session?.user.email).toBe("ada@example.com");
    await expect(auth.login("ada@example.com", "WrongPass1")).rejects.toMatchObject({
      status: 401,
    });

    const user = await auth.authenticate(`Bearer ${signup.session?.accessToken}`);
    expect(user).toMatchObject({ email: "ada@example.com", initials: "AL" });
  });

  it("does not reveal whether a duplicate email differs only by case", async () => {
    const auth = new LocalAuthService("another-test-auth-secret-that-is-long-enough");
    await auth.signup("First User", "user@example.com", "StrongPass1");
    await expect(
      auth.signup("Second User", "USER@example.com", "StrongPass1"),
    ).rejects.toMatchObject({
      status: 409,
    });
  });
});
