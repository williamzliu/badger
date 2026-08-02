import { randomUUID } from "node:crypto";
import {
  type BadgerEvent,
  type CallMetadata,
  type EventSink,
  parseCallMetadata,
} from "../shared/types.js";

export const CARTESIA_API_VERSION = "2026-03-01";

export const BADGER_AGENT_PROMPT = `You are Badger, a warm, concise voice coordinator. You collect private scheduling constraints; you never choose the group plan, but you are allowed to have a natural conversation about what the participant wants.

The call metadata contains participantName, hostName, goal, and may contain purpose and question. For a normal availability call, begin with: "Hey {participantName}, I'm Badger. {hostName} sent me to gather your availability so I can help plan {goal}. This should take about thirty seconds. Is now a good time?"

When purpose is flexibility, this is a targeted callback. Begin with: "Hey {participantName}, it's Badger again. I have one quick follow-up for {hostName} about {goal}. {question}" Ask the supplied compromise question directly; do not restart the whole interview. If they reject one option, capture a nearby alternative instead of treating that as rejection of every plan.

If they do not consent, apologize, thank them for their time, end immediately, and do not submit preferences. Always thank the participant before ending any call, no matter how it went.
If they ask what the activity is, why it may be fun, what the current idea means, or what kind of option they prefer, answer briefly and conversationally before returning to coordination. Use general knowledge and the supplied goal only; never invent live prices, availability, addresses, or facts you were not given. Ask one useful follow-up about what they want from the outing when appropriate.

If they want to change the activity, destination, venue, city, or overall plan, clarify the request once. Preserve any unchanged timing from the original goal and put a complete revised goal in planRequest, such as "go to an escape room in San Francisco this weekend". Do not keep pushing the old option. A change to only a day or time is availability, not a planRequest.

If they consent, naturally cover these points rather than sounding like a form:
1. Ask when they are available for the goal.
2. Ask for hard constraints or times that absolutely cannot work.
3. For each ambiguous restriction, ask: "Is that a hard constraint, or could you be flexible for the right option?"
4. Ask one preference question, such as format or location.
5. Briefly confirm availability, hard vetoes, preferences, and flexibility.
6. After confirmation, call submit_preferences exactly once, then thank them and end the call.

Use short questions, but answer the participant's questions instead of mechanically returning to the checklist. Never mention another participant's private answers. Never invent an answer. When speaking, use natural phrases such as "Friday after eight" or "Saturday afternoon." Never speak underscores, snake_case, JSON, field names, or internal identifiers aloud. Only inside submit_preferences tool arguments, normalize time windows to lowercase snake_case labels such as friday_after_8 or saturday_afternoon. Flexibility is a number from 0 (not flexible) to 1 (very flexible).`;

export const SUBMIT_PREFERENCES_TOOL = {
  type: "function",
  function: {
    name: "submit_preferences",
    description: "Submit the participant's confirmed scheduling constraints exactly once.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "participantId",
        "availability",
        "hardVetoes",
        "preferences",
        "flexibility",
        "summary",
        "planRequest",
      ],
      properties: {
        participantId: { type: "string" },
        availability: { type: "array", items: { type: "string" } },
        hardVetoes: { type: "array", items: { type: "string" } },
        preferences: { type: "array", items: { type: "string" } },
        flexibility: { type: "number", minimum: 0, maximum: 1 },
        summary: { type: "string" },
        planRequest: {
          type: "string",
          description: "Complete revised group goal, or an empty string when no material plan change was requested.",
        },
      },
    },
  },
} as const;

export type CartesiaClientConfig = {
  apiKey: string;
  agentId: string;
  fromNumberId: string;
  baseUrl?: string;
  ringingTimeoutSeconds?: number;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
};

export type PlaceCallInput = {
  to: string;
  metadata: CallMetadata;
  idempotencyKey?: string;
};

export type PlacedCall = {
  agentCallId: string;
  to: string;
};

type CartesiaCallResponse = {
  calls?: Array<{ number?: unknown; agent_call_id?: unknown }>;
};

export class CartesiaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: CartesiaClientConfig) {
    if (!config.apiKey) throw new Error("Cartesia apiKey is required");
    if (!config.agentId) throw new Error("Cartesia agentId is required");
    if (!config.fromNumberId) throw new Error("Cartesia fromNumberId is required");
    this.baseUrl = (config.baseUrl ?? "https://api.cartesia.ai").replace(/\/$/, "");
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  async placeCall(input: PlaceCallInput): Promise<PlacedCall> {
    if (!/^\+[1-9]\d{7,14}$/.test(input.to)) {
      throw new Error("Cartesia destination must be an E.164 phone number");
    }
    const metadata = parseCallMetadata(input.metadata);
    const ringingTimeoutSeconds = this.config.ringingTimeoutSeconds ?? 30;
    if (ringingTimeoutSeconds < 5 || ringingTimeoutSeconds > 80) {
      throw new Error("ringingTimeoutSeconds must be between 5 and 80");
    }

    const response = await this.fetchImpl(`${this.baseUrl}/agents/calls`, {
      method: "POST",
      signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 10_000),
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.config.apiKey,
        "Cartesia-Version": CARTESIA_API_VERSION,
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from_number_id: this.config.fromNumberId,
        agent_id: this.config.agentId,
        ringing_timeout_seconds: ringingTimeoutSeconds,
        outbound_calls: [{ to_number: input.to, metadata }],
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Cartesia outbound call failed (${response.status}): ${raw || response.statusText}`);
    }
    const body = JSON.parse(raw) as CartesiaCallResponse;
    const call = body.calls?.[0];
    if (typeof call?.agent_call_id !== "string") {
      throw new Error("Cartesia response did not include calls[0].agent_call_id");
    }
    return {
      agentCallId: call.agent_call_id,
      to: typeof call.number === "string" ? call.number : input.to,
    };
  }
}

export async function requestBadgerCall(
  client: CartesiaClient,
  input: PlaceCallInput,
  emit: EventSink,
): Promise<PlacedCall> {
  const requestedAt = new Date().toISOString();
  await emit({
    id: input.idempotencyKey ?? randomUUID(),
    sessionId: input.metadata.sessionId,
    participantId: input.metadata.participantId,
    type: "call.requested",
    timestamp: requestedAt,
    publicMessage: `Calling ${input.metadata.participantName}`,
    privateData: {},
  });

  try {
    return await client.placeCall(input);
  } catch (error) {
    const event: BadgerEvent = {
      id: randomUUID(),
      sessionId: input.metadata.sessionId,
      participantId: input.metadata.participantId,
      type: "call.failed",
      timestamp: new Date().toISOString(),
      publicMessage: `Could not reach ${input.metadata.participantName}`,
      privateData: { error: error instanceof Error ? error.message : String(error) },
    };
    await emit(event);
    throw error;
  }
}
