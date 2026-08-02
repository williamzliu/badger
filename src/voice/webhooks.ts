import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  type BadgerEvent,
  type CallMetadata,
  type EventSink,
  type ParticipantPreferences,
  isRecord,
  parseCallMetadata,
  parseParticipantPreferences,
  requireString,
} from "../shared/types.js";

type CartesiaTurn = {
  id?: string | number;
  role?: string;
  text?: string;
  tool_calls?: unknown[];
};

type CartesiaWebhook = {
  type: string;
  call_id: string;
  webhook_request_id: string;
  timestamp?: string;
  call?: {
    metadata?: unknown;
    transcript?: CartesiaTurn[];
    error_message?: string;
    end_reason?: string;
  };
  turn?: CartesiaTurn;
};

export class WebhookDeduplicator {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1_000,
    private readonly maxEntries = 10_000,
  ) {}

  claim(id: string, now = Date.now()): boolean {
    const previous = this.seen.get(id);
    if (previous !== undefined && now - previous < this.ttlMs) return false;
    this.seen.set(id, now);

    if (this.seen.size > this.maxEntries) {
      for (const [key, timestamp] of this.seen) {
        if (now - timestamp >= this.ttlMs || this.seen.size > this.maxEntries) this.seen.delete(key);
      }
    }
    return true;
  }

  release(id: string): void {
    this.seen.delete(id);
  }
}

export class CallMetadataRegistry {
  private readonly calls = new Map<string, CallMetadata>();

  remember(callId: string, metadata: CallMetadata): void {
    this.calls.set(callId, metadata);
  }

  get(callId: string): CallMetadata | undefined {
    return this.calls.get(callId);
  }

  forget(callId: string): void {
    this.calls.delete(callId);
  }
}

function secureEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseCartesiaWebhook(body: unknown): CartesiaWebhook {
  if (!isRecord(body)) throw new Error("Cartesia webhook body must be an object");
  const type = requireString(body.type, "webhook.type");
  const callId = requireString(body.call_id, "webhook.call_id");
  const requestId = requireString(body.webhook_request_id, "webhook.webhook_request_id");
  return {
    ...(body as CartesiaWebhook),
    type,
    call_id: callId,
    webhook_request_id: requestId,
  };
}

function parseToolArguments(toolCall: unknown): unknown {
  if (!isRecord(toolCall)) return undefined;
  const fn = isRecord(toolCall.function) ? toolCall.function : undefined;
  const name = toolCall.name ?? fn?.name;
  if (name !== "submit_preferences") return undefined;
  const args = toolCall.arguments ?? fn?.arguments ?? toolCall.input;
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    throw new Error("submit_preferences arguments were not valid JSON");
  }
}

export function findSubmittedPreferences(
  turns: CartesiaTurn[] | undefined,
  metadata: CallMetadata,
): ParticipantPreferences | undefined {
  for (const turn of turns ?? []) {
    for (const toolCall of turn.tool_calls ?? []) {
      const args = parseToolArguments(toolCall);
      if (args === undefined) continue;
      if (!isRecord(args)) throw new Error("submit_preferences arguments must be an object");
      const parsed = parseParticipantPreferences({ ...args, participantId: metadata.participantId });
      return parsed;
    }
  }
  return undefined;
}

export type CartesiaWebhookProcessorConfig = {
  webhookSecret: string;
  emit: EventSink;
  deduplicator?: WebhookDeduplicator;
  callRegistry?: CallMetadataRegistry;
  lookupMetadata?: (callId: string) => CallMetadata | undefined | Promise<CallMetadata | undefined>;
};

export type WebhookProcessResult = { duplicate: boolean; events: BadgerEvent[] };

export class CartesiaWebhookProcessor {
  private readonly dedupe: WebhookDeduplicator;
  private readonly callRegistry: CallMetadataRegistry;

  constructor(private readonly config: CartesiaWebhookProcessorConfig) {
    if (!config.webhookSecret) throw new Error("Cartesia webhookSecret is required");
    this.dedupe = config.deduplicator ?? new WebhookDeduplicator();
    this.callRegistry = config.callRegistry ?? new CallMetadataRegistry();
  }

  async process(secret: string | undefined, rawBody: unknown): Promise<WebhookProcessResult> {
    if (!secureEqual(secret, this.config.webhookSecret)) throw new Error("Invalid Cartesia webhook secret");
    const body = parseCartesiaWebhook(rawBody);
    if (!this.dedupe.claim(body.webhook_request_id)) return { duplicate: true, events: [] };

    try {
      return await this.processClaimed(body);
    } catch (error) {
      // Only successful processing claims an event permanently. A missing dependency or
      // transient event-store failure must remain retryable when Cartesia redelivers it.
      this.dedupe.release(body.webhook_request_id);
      throw error;
    }
  }

  private async processClaimed(body: CartesiaWebhook): Promise<WebhookProcessResult> {
    const metadataValue = body.call?.metadata;
    const eventMetadata = metadataValue ? parseCallMetadata(metadataValue) : undefined;
    if (eventMetadata) this.callRegistry.remember(body.call_id, eventMetadata);
    const metadata =
      eventMetadata ??
      this.callRegistry.get(body.call_id) ??
      (await this.config.lookupMetadata?.(body.call_id));
    if (!metadata) throw new Error(`No Badger metadata found for Cartesia call ${body.call_id}`);

    const timestamp = body.timestamp ?? new Date().toISOString();
    const base = {
      sessionId: metadata.sessionId,
      participantId: metadata.participantId,
      timestamp,
    };
    const events: BadgerEvent[] = [];
    const push = (event: Omit<BadgerEvent, "id">) =>
      events.push({ id: `${body.webhook_request_id}:${events.length}`, ...event });

    switch (body.type) {
      case "call_ringing":
        push({ ...base, type: "call.ringing", publicMessage: `${metadata.participantName}'s phone is ringing`, privateData: {} });
        break;
      case "call_started":
        push({ ...base, type: "call.started", publicMessage: `${metadata.participantName} answered`, privateData: {} });
        break;
      case "call_turn":
        push({
          ...base,
          type: "call.turn",
          publicMessage: "Conversation in progress",
          privateData: {
            callId: body.call_id,
            turnId: body.turn?.id,
            role: body.turn?.role,
          },
        });
        break;
      case "call_completed": {
        push({
          ...base,
          type: "call.completed",
          publicMessage: `${metadata.participantName}'s call completed`,
          privateData: { callId: body.call_id, endReason: body.call?.end_reason },
        });
        const preferences = findSubmittedPreferences(body.call?.transcript, metadata);
        if (preferences) {
          push({
            ...base,
            type: "preferences.received",
            publicMessage: `${metadata.participantName}'s availability received`,
            privateData: { preferences },
          });
        }
        break;
      }
      case "call_failed":
        push({
          ...base,
          type: "call.failed",
          publicMessage: `Could not reach ${metadata.participantName}`,
          privateData: {
            callId: body.call_id,
            endReason: body.call?.end_reason,
            error: body.call?.error_message,
          },
        });
        break;
      case "post_call_analysis":
        break;
      default:
        throw new Error(`Unsupported Cartesia webhook type: ${body.type}`);
    }

    for (const event of events) await this.config.emit(event);
    if (body.type === "call_completed" || body.type === "call_failed") {
      this.callRegistry.forget(body.call_id);
    }
    return { duplicate: false, events };
  }
}

export async function processSubmittedPreferences(input: {
  body: unknown;
  sessionId: string;
  participantName?: string;
  emit: EventSink;
}): Promise<ParticipantPreferences> {
  const preferences = parseParticipantPreferences(input.body);
  await input.emit({
    id: randomUUID(),
    sessionId: input.sessionId,
    participantId: preferences.participantId,
    type: "preferences.received",
    timestamp: new Date().toISOString(),
    publicMessage: `${input.participantName ?? "Participant"}'s availability received`,
    privateData: { preferences },
  });
  return preferences;
}
