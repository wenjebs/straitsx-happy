/*
 * Static UI copy.
 *
 * This file used to hold every piece of dummy content in the prototype — a six-item PC build, its
 * fabricated listings and sellers, an authored stage script per item, a fake archive, fake cards
 * and fake transactions. All of it is gone: the wishlist comes from the planner, the listings come
 * from scouts driving real browsers over verified storefronts, and the archive, wallet and profile
 * come from the backend.
 *
 * What is left is copy the client owns and the server has no opinion about.
 */

/** The five stops an agent moves between. Index doubles as track position. */
export const STAGES = ["Discovering", "Analyzing", "Gathering", "Comparing", "Selected"] as const;
export type StageIndex = 0 | 1 | 2 | 3 | 4;

/** Labels for the Closer's four execution steps. */
export const EXEC_STEPS = [
  "requesting card",
  "entering checkout",
  "confirming order",
  "order confirmed",
] as const;

/** Prompt chips on the empty chat screen. */
export const SUGGESTIONS = [
  "buy a bag of filter coffee under S$30",
  "find me a notebook and a pen from a local design store",
  "a paperback under S$25, picked up in person",
] as const;

export function money(n: number): string {
  return `S$${n.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
