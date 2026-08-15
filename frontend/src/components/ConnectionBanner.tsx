import type { ConnectionState } from "../lib/Api";
import { API_BASE_URL } from "../lib/Api";
import styles from "./ConnectionBanner.module.css";

interface ConnectionBannerProps {
  connection: ConnectionState;
  error: string | null;
  onDismiss: () => void;
}

/**
 * Surfaces transport trouble without tearing the view down.
 *
 * Deliberately never falls back to mock data when a configured backend is
 * unreachable: silently swapping real agent state for a simulation would be
 * misleading at any time, and dangerous on a rail that spends real money.
 */
export function ConnectionBanner({ connection, error, onDismiss }: ConnectionBannerProps) {
  if (connection === "mock" && !error) return null;
  if (connection === "open" && !error) return null;

  const tone =
    connection === "error" || error
      ? styles.error
      : connection === "connecting"
        ? styles.connecting
        : "";

  /*
   * Name the origin. A bare "Failed to fetch" leaves the reader guessing
   * whether the backend is down, the URL is wrong, or CORS rejected them.
   */
  const message =
    connection === "connecting" && !error
      ? `connecting to ${API_BASE_URL}…`
      : error
        ? `${API_BASE_URL || "backend"} · ${error} — check the backend is running and allows this origin`
        : "backend unreachable · showing last known state, not live agent progress";

  return (
    <div className={`${styles.banner} ${tone}`}>
      <span className={styles.dot} />
      <span className={styles.message}>{message}</span>
      {error && (
        <button type="button" className={styles.dismiss} onClick={onDismiss}>
          dismiss
        </button>
      )}
    </div>
  );
}
