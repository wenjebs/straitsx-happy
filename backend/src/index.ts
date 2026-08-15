import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EventHub } from "./events.js";
import {
  type AgentProvider,
  DisabledAgentProvider,
  RemoteAgentProvider,
} from "./providers/agent.js";
import {
  DisabledPaymentProvider,
  type PaymentProvider,
  RemotePaymentProvider,
} from "./providers/payment.js";
import { DynamoRepository } from "./repositories/dynamodb.js";
import { MemoryRepository } from "./repositories/memory.js";
import type { Repository } from "./repository.js";
import { ActivityService } from "./services/activities.js";
import { PurchaseService } from "./services/purchases.js";

const config = loadConfig();
const repository: Repository = createRepository();
const events = new EventHub();
const agents: AgentProvider = config.AGENT_API_BASE_URL
  ? new RemoteAgentProvider({
      baseUrl: config.AGENT_API_BASE_URL,
      callbackBaseUrl: config.PUBLIC_BASE_URL,
      ...(config.AGENT_API_TOKEN ? { token: config.AGENT_API_TOKEN } : {}),
      ...(config.AGENT_CALLBACK_TOKEN ? { callbackToken: config.AGENT_CALLBACK_TOKEN } : {}),
    })
  : new DisabledAgentProvider();
const payments: PaymentProvider = config.PAYMENT_API_BASE_URL
  ? new RemotePaymentProvider({
      baseUrl: config.PAYMENT_API_BASE_URL,
      ...(config.PAYMENT_API_TOKEN ? { token: config.PAYMENT_API_TOKEN } : {}),
    })
  : new DisabledPaymentProvider();
const activities = new ActivityService(repository, events, agents);
const purchases = new PurchaseService(repository, events, payments, config);
const app = createApp({ config, repository, events, agents, payments, activities, purchases });

const server = serve({ fetch: app.fetch, port: config.PORT }, ({ port }) => {
  console.log(
    `happy-backend http://127.0.0.1:${port} store=${config.DATA_STORE} agents=${agents.mode} payments=${payments.mode}`,
  );
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

export { app };

function createRepository(): Repository {
  if (config.DATA_STORE === "memory") return new MemoryRepository();
  if (!config.DYNAMODB_TABLE) {
    throw new Error("DYNAMODB_TABLE is required when DATA_STORE=dynamodb");
  }
  return new DynamoRepository({
    tableName: config.DYNAMODB_TABLE,
    region: config.AWS_REGION,
    ...(config.DYNAMODB_ENDPOINT ? { endpoint: config.DYNAMODB_ENDPOINT } : {}),
  });
}
