import { type FormEvent, useState } from "react";
import type { SignupResult } from "../lib/Api";
import styles from "./LoginScreen.module.css";

interface LoginScreenProps {
  working: boolean;
  error: string | null;
  onLogin: (email: string, password: string) => Promise<void>;
  onSignup: (name: string, email: string, password: string) => Promise<SignupResult>;
  onConfirm: (email: string, code: string) => Promise<void>;
  onClearError: () => void;
}

type View = "login" | "signup" | "confirm";

export function LoginScreen({
  working,
  error,
  onLogin,
  onSignup,
  onConfirm,
  onClearError,
}: LoginScreenProps) {
  const [view, setView] = useState<View>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const changeView = (next: View) => {
    setView(next);
    setNotice(null);
    onClearError();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);
    try {
      if (view === "login") {
        await onLogin(email, password);
        return;
      }
      if (view === "signup") {
        const result = await onSignup(name, email, password);
        if (result.confirmationRequired) {
          setEmail(result.email);
          setPassword("");
          setView("confirm");
        }
        return;
      }
      await onConfirm(email, code);
      setCode("");
      setView("login");
      setNotice("Email confirmed. Sign in to continue.");
    } catch {
      /* The auth hook owns and renders the error. */
    }
  };

  const title =
    view === "login"
      ? "Welcome back"
      : view === "signup"
        ? "Create your account"
        : "Check your email";
  const subtitle =
    view === "login"
      ? "Sign in to continue your activities and wallet."
      : view === "signup"
        ? "Your chats, approvals and funding ledger stay with this account."
        : `Enter the confirmation code sent to ${email}.`;

  return (
    <main className={styles.page}>
      <section className={styles.story} aria-label="About Happy">
        <div className={styles.brand}>
          <img src="/happy-mascot.png" alt="" className={styles.mark} />
          <span>Happy</span>
        </div>
        <div className={styles.storyBody}>
          <div className={styles.eyebrow}>AGENTIC COMMERCE, WITH BOUNDARIES</div>
          <h1>Tell Happy what you need. Stay in control of what it spends.</h1>
          <p>
            One account keeps every wishlist decision, Scout update, approval and purchase record
            together.
          </p>
          <div className={styles.steps}>
            <span>01&nbsp; Plan</span>
            <span>02&nbsp; Approve</span>
            <span>03&nbsp; Fund</span>
            <span>04&nbsp; Buy</span>
          </div>
        </div>
        <div className={styles.safety}>
          Wallet access is authorized separately and never reveals your recovery phrase.
        </div>
      </section>

      <section className={styles.auth}>
        <div className={styles.card}>
          <div className={styles.mobileBrand}>
            <img src="/happy-mascot.png" alt="" className={styles.mark} />
            <span>Happy</span>
          </div>
          <div className={styles.heading}>
            <div className={styles.eyebrow}>HAPPY ACCOUNT</div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>

          <form onSubmit={(event) => void submit(event)} className={styles.form}>
            {view === "signup" && (
              <label>
                <span>Name</span>
                <input
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Your name"
                  minLength={2}
                  maxLength={80}
                  required
                />
              </label>
            )}

            <label>
              <span>Email</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                disabled={view === "confirm"}
                required
              />
            </label>

            {view !== "confirm" && (
              <label>
                <span>Password</span>
                <input
                  type="password"
                  autoComplete={view === "signup" ? "new-password" : "current-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                  minLength={8}
                  maxLength={128}
                  required
                />
                {view === "signup" && (
                  <small>Use uppercase, lowercase and at least one number.</small>
                )}
              </label>
            )}

            {view === "confirm" && (
              <label>
                <span>Confirmation code</span>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="123456"
                  minLength={4}
                  maxLength={12}
                  required
                />
              </label>
            )}

            {(error || notice) && (
              <div
                className={error ? styles.error : styles.notice}
                role={error ? "alert" : "status"}
              >
                {error ?? notice}
              </div>
            )}

            <button type="submit" className={styles.primary} disabled={working}>
              {working
                ? "Please wait…"
                : view === "login"
                  ? "Sign in"
                  : view === "signup"
                    ? "Create account"
                    : "Confirm email"}
            </button>
          </form>

          <div className={styles.switcher}>
            {view === "login" ? (
              <>
                New to Happy?{" "}
                <button type="button" onClick={() => changeView("signup")}>
                  Create an account
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button type="button" onClick={() => changeView("login")}>
                  Sign in
                </button>
              </>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
