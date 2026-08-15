/**
 * Claiming and revealing the card Happy issued.
 *
 * Two rules govern this file and neither is negotiable. The claim happens at most once per attempt
 * — enforced by the job store, not here, because a guard next to the fetch is a guard someone
 * reorders. And nothing in here is ever logged: the values it handles ARE the card, so an error
 * message that interpolates a response body is a card leak into whatever collects logs.
 */
export type CardMaterial = {
  pan: string;
  expiryMonth: string;
  expiryYear: string;
  cvc: string;
};

export type ClaimedCard = {
  cardId: string;
  last4: string;
  agentAccess: { revealUrl: string; token: string; expiresAt?: string | undefined };
};

export async function claimCard(
  grant: { claimUrl: string; token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimedCard> {
  const res = await fetchImpl(grant.claimUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${grant.token}` },
  });
  // Deliberately excludes the body: a claim response carries card metadata.
  if (!res.ok) throw new Error(`card claim refused (${res.status})`);
  const data = (await res.json()) as ClaimedCard;
  if (!data?.agentAccess?.revealUrl || !data.agentAccess.token) {
    throw new Error("card claim returned no agent access capability");
  }
  return data;
}

export async function revealCard(
  access: { revealUrl: string; token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<CardMaterial> {
  const res = await fetchImpl(access.revealUrl, {
    method: "GET",
    headers: { authorization: `Bearer ${access.token}` },
  });
  if (!res.ok) throw new Error(`card reveal refused (${res.status})`);
  const data = (await res.json()) as Partial<CardMaterial>;
  if (!data.pan || !data.expiryMonth || !data.expiryYear || !data.cvc) {
    // Names which kinds of field are missing, never their values.
    throw new Error("card reveal returned incomplete card material");
  }
  return {
    pan: data.pan,
    expiryMonth: data.expiryMonth,
    expiryYear: data.expiryYear,
    cvc: data.cvc,
  };
}
