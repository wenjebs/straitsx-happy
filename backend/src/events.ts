import type { ActivityEvent } from "./domain.js";

type Listener = (event: ActivityEvent) => void | Promise<void>;

/**
 * Process-local fan-out for live SSE clients. ECS is intentionally deployed as
 * one task initially; reconnects always receive a DynamoDB snapshot, so task
 * replacement cannot make persisted state stale.
 */
export class EventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(activityId: string, listener: Listener): () => void {
    const set = this.listeners.get(activityId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(activityId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(activityId);
    };
  }

  emit(activityId: string, event: ActivityEvent): void {
    for (const listener of this.listeners.get(activityId) ?? []) {
      void Promise.resolve(listener(event)).catch(() => {
        // A disconnected client must never interrupt agent or payment work.
      });
    }
  }
}
