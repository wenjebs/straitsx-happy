/**
 * Run logging for the purchase service.
 *
 * A run happens inside a remote browser with no console of its own, so without this a failure is a
 * `purchase.failed` string in the UI and nothing else to go on.
 *
 * NEVER log card material. `claimCard` and `revealCard` already keep response bodies out of their
 * errors; this keeps them out of progress lines too. Log what step we are on and what the page
 * looked like, never what was typed into it.
 */
const stamp = () => new Date().toISOString().slice(11, 23);

export type RunLog = (message: string, detail?: Record<string, unknown>) => void;

export function runLogger(attemptId: string): RunLog {
  const short = attemptId.length > 18 ? `${attemptId.slice(0, 16)}…` : attemptId;
  return (message, detail) => {
    const extra = detail
      ? " " +
        Object.entries(detail)
          .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(" ")
      : "";
    console.log(`[${stamp()}] [${short}] ${message}${extra}`);
  };
}
