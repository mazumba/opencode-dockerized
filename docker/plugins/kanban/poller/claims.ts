// The claim marker: an eyes reaction by the poller on the ticket. Writes happen in an order that never
// leaves a ticket unclaimed halfway: the new reaction is added before older ones are removed.
import { REACTION, viewerClaimReactionIds, type Issue } from "./select.ts";

export interface ClaimApi {
  reactToIssue(issueId: string, emoji: string): Promise<void>;
  deleteReaction(id: string): Promise<void>;
  issue(identifier: string): Promise<Issue>;
}

/** A reaction that is already gone (deleted by someone, or by an earlier pass) is not an error. */
async function deleteIfPresent(api: ClaimApi, id: string): Promise<void> {
  try {
    await api.deleteReaction(id);
  } catch (error) {
    if (!/not found/i.test((error as Error).message)) throw error;
  }
}

/** Adds a fresh claim, then removes the claims that were on `issue` before. */
export async function claimIssue(api: ClaimApi, issue: Issue, viewerId: string): Promise<void> {
  const older = viewerClaimReactionIds(issue, viewerId);
  await api.reactToIssue(issue.id, REACTION.claimed);
  for (const id of older) await deleteIfPresent(api, id);
}

/** Removes every claim of the poller from the ticket, reading its current reactions first. */
export async function releaseClaim(api: ClaimApi, identifier: string, viewerId: string): Promise<void> {
  const fresh = await api.issue(identifier);
  for (const id of viewerClaimReactionIds(fresh, viewerId)) await deleteIfPresent(api, id);
}
