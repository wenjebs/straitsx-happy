/**
 * Serialises read-modify-write on one user's wallet.
 *
 * The wallet is fetched, mutated and written back in several places, and every one of them holds
 * the object across an await — `issueCard` alone can take 45 seconds. Sequentially that was
 * harmless. Concurrently it is not: six attempts claiming at once each read the same balance, each
 * append their own card row, and the last write wins. Five card rows vanish and the balance
 * under-reports money that has genuinely left, which then lets the balance guard authorise cards
 * against funds already spent.
 *
 * A per-user queue rather than a version check, because this backend runs in one process and a
 * queue is correct here without a schema change. If it is ever run in more than one process this is
 * NOT enough — that needs a conditional write on a version attribute, and this comment is the
 * warning that it was a deliberate, bounded choice.
 */
const chains = new Map<string, Promise<unknown>>();

export function withWallet<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(userId) ?? Promise.resolve();
  // Errors must not poison the chain for the next caller, hence the catch on the tail.
  const next = previous.then(fn, fn);
  chains.set(
    userId,
    next.catch(() => undefined),
  );
  return next;
}
