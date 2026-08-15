import { useCallback, useEffect, useState } from "react";
import * as Api from "../lib/Api";

export interface AuthState {
  loading: boolean;
  user: Api.AuthUser | null;
  error: string | null;
  working: boolean;
}

export interface AuthActions {
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<Api.SignupResult>;
  confirmSignup: (email: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export function useAuth(): { state: AuthState; actions: AuthActions } {
  const [state, setState] = useState<AuthState>({
    loading: true,
    user: null,
    error: null,
    working: false,
  });

  const load = useCallback(async () => {
    if (Api.isLive() && !Api.hasAuthSession()) {
      setState((current) => ({ ...current, loading: false, user: null }));
      return;
    }
    try {
      const user = await Api.getCurrentUser();
      setState({ loading: false, user, error: null, working: false });
    } catch (error) {
      setState({
        loading: false,
        user: null,
        error: error instanceof Error ? error.message : String(error),
        working: false,
      });
    }
  }, []);

  useEffect(() => {
    void load();
    return Api.onAuthChanged(() => void load());
  }, [load]);

  const run = useCallback(async <T>(action: () => Promise<T>): Promise<T> => {
    setState((current) => ({ ...current, working: true, error: null }));
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((current) => ({ ...current, working: false, error: message }));
      throw error;
    }
  }, []);

  return {
    state,
    actions: {
      login: (email, password) =>
        run(async () => {
          const session = await Api.login(email, password);
          setState({ loading: false, user: session.user, error: null, working: false });
        }),
      signup: (name, email, password) =>
        run(async () => {
          const result = await Api.signup(name, email, password);
          if (result.session) {
            setState({
              loading: false,
              user: result.session.user,
              error: null,
              working: false,
            });
          } else {
            setState((current) => ({ ...current, working: false }));
          }
          return result;
        }),
      confirmSignup: (email, code) =>
        run(async () => {
          await Api.confirmSignup(email, code);
          setState((current) => ({ ...current, working: false }));
        }),
      logout: () =>
        run(async () => {
          await Api.logout();
          setState({ loading: false, user: null, error: null, working: false });
        }),
      clearError: () => setState((current) => ({ ...current, error: null })),
    },
  };
}
