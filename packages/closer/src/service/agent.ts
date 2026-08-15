import type { Page } from "playwright";
import { hasUsableCardField, observe } from "./navigator.js";
import { describe, executeTool, Refused, TOOL_SCHEMA, type ToolCall } from "./tools.js";

/**
 * A model driving a checkout through tool calls.
 *
 * Each turn it sees the page as a numbered list of elements, calls a tool, and reads back what
 * happened. That loop handles the part deterministic selectors cannot: real checkouts ask for an
 * email, a delivery method and a postal code in an order that differs per shop, and one of them
 * offers a payment method literally labelled "For Internal Use (Do not select)".
 *
 * ## Where the model stops
 *
 * At the card. It drives until card fields exist and then hands over; `typeCardInto` fills them
 * with no model in the loop. The page description omits every input's VALUE, so a model resuming
 * mid-checkout cannot read back a number already typed. That is invariant 10 — card material never
 * reaches anywhere a model prompt could.
 *
 * The loop also checks for card fields itself before every turn, so a page that reaches payment
 * ends the conversation whether or not the model noticed.
 */

export type ModelReply = { text?: string; toolCalls?: ToolCall[] };

export type ModelClient = (
  messages: unknown[],
  tools: typeof TOOL_SCHEMA,
) => Promise<ModelReply>;

export type AgentDeps = {
  model: ModelClient;
  log?: (m: string, d?: Record<string, unknown>) => void;
  maxTurns?: number;
};

const SYSTEM = `You are driving a real web browser to reach the payment step of an online checkout.

Each turn you are shown the page as a numbered list of interactive elements. Call exactly one tool.

Your goal: get to the point where the credit card fields are on screen, then call "finished".

Hard rules:
- NEVER press a button that places the order. Someone else does that after checking the total.
- NEVER type a card number, expiry date or security code. Another system enters those. You will
  never be given them and must never invent them.
- Keep "Credit card" as the payment method. Never choose one labelled "do not select" or "internal
  use", and do not pick an instalment plan or a wallet.
- Do not change the quantity or the product variant. What is selected was already approved, and
  other variants are priced differently.
- Use a plausible Singapore delivery address if one is required.

If the page is a bot wall, an error, or demands an account you cannot create, call "give_up" and
quote what it says.`;

/**
 * Drives the page until card fields exist.
 *
 * Throws when the model gives up, runs out of turns, or attempts something refused — the caller
 * treats any of those as a failed purchase, which is correct: no card has been claimed yet.
 */
export async function runBrowserAgent(
  page: Page,
  deps: AgentDeps,
  opts: { allowedHost: string; goal: string },
): Promise<void> {
  const log = deps.log ?? (() => {});
  const maxTurns = deps.maxTurns ?? 14;

  const messages: unknown[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `GOAL: ${opts.goal}` },
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    // Checked before asking: a page already at payment ends this whether the model noticed or not.
    if (await hasUsableCardField(page)) {
      log("agent: card fields present", { turn });
      return;
    }

    const elements = await observe(page);
    messages.push({ role: "user", content: describe(elements, page.url()) });

    const reply = await deps.model(messages, TOOL_SCHEMA);
    const calls = reply.toolCalls ?? [];

    if (calls.length === 0) {
      log("agent: no tool call", { turn, said: (reply.text ?? "").slice(0, 100) });
      messages.push({
        role: "user",
        content: "Call one of the tools. Do not reply with prose.",
      });
      continue;
    }

    messages.push({
      role: "assistant",
      content: reply.text ?? null,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    });

    for (const call of calls) {
      log("agent", { turn, tool: call.name, why: String(call.args.why ?? "").slice(0, 70) });

      let result: string;
      try {
        const outcome = await executeTool(page, elements, call, opts.allowedHost);
        if (outcome.kind === "finished") {
          // The model's opinion is not enough: a page with no card field is not finished.
          if (await hasUsableCardField(page)) {
            log("agent: finished", { turn, why: outcome.why });
            return;
          }
          result = "there are no card fields on this page yet — keep going";
        } else if (outcome.kind === "gave_up") {
          throw new Error(`browser agent gave up: ${outcome.why}`);
        } else {
          result = outcome.result;
        }
      } catch (error) {
        // Refused is never handed back for a retry: each case either spends money or hands over a
        // card, and a model that just tried it should not get another go at the same page.
        if (error instanceof Refused) {
          log("agent: REFUSED", { turn, reason: error.message });
          throw new Error(`browser agent refused: ${error.message}`);
        }
        if (error instanceof Error && error.message.startsWith("browser agent gave up")) throw error;
        result = `that failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  throw new Error(`browser agent ran out of turns at ${page.url()}`);
}

/**
 * An OpenAI-compatible tool-calling client.
 *
 * Deliberately the only place a provider is named. Swapping to Bedrock means writing another
 * function with this signature and nothing else changes — the loop, the tools and every guard are
 * provider-agnostic.
 */
export function openAiClient(): ModelClient {
  return async (messages, tools) => {
    const base = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
        messages,
        tools,
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`browser agent model call failed (${res.status})`);
    }
    const data = (await res.json()) as {
      choices?: {
        message?: {
          content?: string;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
        };
      }[];
    };
    const message = data.choices?.[0]?.message;
    return {
      ...(message?.content ? { text: message.content } : {}),
      toolCalls: (message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        args: safeParse(c.function.arguments),
      })),
    };
  };
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
