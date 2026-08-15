import type { Mandate, Profile, Settings, Wallet } from "./domain.js";

export function defaultWallet(): Wallet {
  return {
    balanceMinor: 482_050,
    address: "0x8f…c14b",
    network: "Avalanche Fuji",
    cards: [],
    transactions: [],
  };
}

/** A newly authenticated funding account starts empty; only verified deposits can credit it. */
export function defaultFundingWallet(): Wallet {
  return {
    balanceMinor: 0,
    address: "Not configured",
    network: "Not configured",
    cards: [],
    transactions: [],
  };
}

export function defaultMandate(): Mandate {
  return {
    autoApprove: true,
    itemCap: 600,
    actCap: 2500,
  };
}

export function defaultSettings(): Settings {
  return {
    region: "Singapore · SGD",
    dataRetention: "90 days",
  };
}

export function defaultProfile(): Profile {
  return {
    name: "Tricia Lim",
    email: "tricia.lim@hey.sg",
    initials: "TL",
    memberSince: "tricia.lim@hey.sg · member since Mar 2026",
    rows: [
      { k: "Name", v: "Tricia Lim" },
      { k: "Email", v: "tricia.lim@hey.sg" },
      { k: "Linked wallet", v: "0x8f41c2ba9d7e5f30a6b1d4c9e2f7a8b0c14b" },
      { k: "Wallet network", v: "Avalanche Fuji · XSGD" },
      { k: "Agent identity", v: "happy-agent/2.0 (tricia-lim)" },
    ],
  };
}
