/**
 * Lists the account's browser profiles with their status.
 *
 * Exists because `SaveBrowserSessionProfile` started answering AccessDeniedException again after
 * two successful saves, and a profile's own status is the first thing to rule out before blaming
 * IAM.
 *
 *   AWS_PROFILE=happy pnpm --filter @happy/closer exec tsx probe/agentcore-profile-list.ts
 */
import {
  BedrockAgentCoreControlClient,
  ListBrowserProfilesCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const control = new BedrockAgentCoreControlClient({
  region: "ap-southeast-1",
  credentials: fromNodeProviderChain({ profile: process.env.AWS_PROFILE ?? "happy" }),
});

const res = await control.send(new ListBrowserProfilesCommand({}));
console.log(JSON.stringify(res.profileSummaries ?? [], null, 2));
