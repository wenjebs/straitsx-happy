import { z } from "zod";

export const CreateActivityBody = z.object({ goal: z.string().trim().min(1).max(4000) });
export const AddWishlistItemBody = z.object({ name: z.string().trim().min(1).max(160) });
export const ChooseOptionBody = z.object({ option: z.string().trim().min(1).max(240) });
export const PurchaseBody = z.object({ idempotencyKey: z.string().trim().min(8).max(240) });
export const TopUpBody = z.object({ amountMinor: z.number().int().positive().max(100_000_000) });

const CategoryRule = z.enum(["allowed", "ask first", "blocked"]);
export const MandatePatch = z
  .object({
    autoApprove: z.boolean().optional(),
    itemCap: z.number().int().min(1).max(1_000_000).optional(),
    actCap: z.number().int().min(1).max(1_000_000).optional(),
    categoryRules: z.record(z.string().min(1), CategoryRule).optional(),
  })
  .strict();

export const SettingsPatch = z
  .object({
    notify: z.boolean().optional(),
    sandbox: z.boolean().optional(),
    region: z.string().min(1).max(120).optional(),
    dataRetention: z.string().min(1).max(120).optional(),
  })
  .strict();

const StageIndex = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);

const WishlistItem = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(240),
  short: z.string().min(1).max(16),
  spec: z.string().max(1000),
  budget: z.string().max(100),
  hueIndex: z.number().int().min(0).max(5),
  category: z.string().min(1).max(100).optional(),
});

const CuratorOption = z.object({
  name: z.string().min(1).max(240),
  range: z.string().max(100),
  why: z.string().max(1000),
  imgLabel: z.string().max(100),
  imageUrl: z.url().optional(),
});

const Clarification = z.object({
  itemId: z.string().min(1).max(100),
  prompt: z.string().max(1000),
  options: z.array(CuratorOption).min(1).max(4),
});

const Listing = z.object({
  title: z.string().min(1).max(500),
  seller: z.string().min(1).max(240),
  rating: z.string().max(200),
  price: z.string().min(1).max(100),
  amountMinor: z.number().int().positive(),
  why: z.string().max(2000),
  imageUrl: z.url().optional(),
  url: z.url().optional(),
});

export const AgentCallbackEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("wishlist.ready"),
    title: z.string().min(1).max(240),
    reply: z.string().max(4000),
    wishlist: z.array(WishlistItem).min(1).max(10),
    wishlistEstimate: z.string().max(100),
    clarifications: z.array(Clarification).max(10).default([]),
  }),
  z.object({
    type: z.literal("item.progress"),
    progress: z.object({
      itemId: z.string().min(1).max(100),
      stage: StageIndex,
      previousStage: StageIndex,
      queued: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal("agent.update"),
    agent: z.object({
      agentId: z.string().min(1).max(160),
      itemId: z.string().min(1).max(100),
      slot: z.number().int().min(0).max(1),
      url: z.string().max(2000),
      stage: StageIndex,
      action: z.string().max(500),
      queued: z.boolean(),
      liveStreamUrl: z.url().optional(),
    }),
  }),
  z.object({
    type: z.literal("shortlist.ready"),
    shortlist: z
      .array(
        z.object({
          itemId: z.string().min(1).max(100),
          listing: Listing,
          reSearched: z.boolean().default(false),
          alternates: z.array(Listing).max(10).optional(),
        }),
      )
      .min(1)
      .max(10),
  }),
  z.object({
    type: z.literal("message.appended"),
    message: z.object({
      id: z.string().min(1).max(160),
      role: z.enum(["user", "assistant"]),
      text: z.string().max(4000),
    }),
  }),
  z.object({
    type: z.literal("run.failed"),
    message: z.string().min(1).max(2000),
  }),
]);

export type AgentCallback = z.infer<typeof AgentCallbackEvent>;
