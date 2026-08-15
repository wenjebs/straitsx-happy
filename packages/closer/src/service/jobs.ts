/**
 * Job and idempotency records for the purchase service.
 *
 * In memory on purpose: one process, one weekend. The one guarantee that genuinely matters —
 * a card is claimed at most once per idempotency key — lives HERE rather than beside the fetch
 * that claims it, because a guard next to the call site is a guard someone reorders. Getting it
 * wrong spends real money twice.
 */
export type JobState = "accepted" | "running" | "done" | "failed" | "cancelled";

export type Job = {
  activityId: string;
  attemptId: string;
  idempotencyKey: string;
  state: JobState;
  cardClaimed: boolean;
  seq: number;
};

export interface JobStore {
  accept(input: {
    activityId: string;
    attemptId: string;
    idempotencyKey: string;
  }): { job: Job; created: boolean };
  get(idempotencyKey: string): Job | undefined;
  setState(idempotencyKey: string, state: JobState): void;
  /** True for the first caller only. Every later caller gets false. */
  claimCardOnce(idempotencyKey: string): boolean;
  cancel(activityId: string, attemptId?: string): void;
  isCancelled(attemptId: string): boolean;
  nextSeq(idempotencyKey: string): number;
}

export function createJobStore(): JobStore {
  const byKey = new Map<string, Job>();
  const cancelled = new Set<string>();

  return {
    accept(input) {
      const existing = byKey.get(input.idempotencyKey);
      if (existing) return { job: existing, created: false };
      const job: Job = { ...input, state: "accepted", cardClaimed: false, seq: 0 };
      byKey.set(input.idempotencyKey, job);
      return { job, created: true };
    },

    get: (key) => byKey.get(key),

    setState(key, state) {
      const job = byKey.get(key);
      if (job) job.state = state;
    },

    claimCardOnce(key) {
      const job = byKey.get(key);
      if (!job || job.cardClaimed) return false;
      job.cardClaimed = true;
      return true;
    },

    cancel(activityId, attemptId) {
      if (attemptId) {
        cancelled.add(attemptId);
        return;
      }
      for (const job of byKey.values()) {
        if (job.activityId === activityId) cancelled.add(job.attemptId);
      }
    },

    isCancelled: (attemptId) => cancelled.has(attemptId),

    nextSeq(key) {
      const job = byKey.get(key);
      if (!job) return 0;
      job.seq += 1;
      return job.seq;
    },
  };
}
