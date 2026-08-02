import { randomUUID } from "node:crypto";
import { Spectrum } from "@spectrum-ts/core";
import { imessage } from "@spectrum-ts/imessage";
import { type BadgerEvent, type EventSink } from "../shared/types.js";
import { formatCandidateTime } from "../shared/display.js";

const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export const displayCandidateTime = formatCandidateTime;

export const MESSAGE_COPY = {
  opening: (hostName: string, goal: string) =>
    `${hostName} asked Badger to coordinate ${goal}. I'll call you in about 10 seconds. Reply STOP to opt out.`,
  missedCall: () => "I couldn't reach you. When are you free for the plan?",
  proposal: (time: string, theater: string) =>
    `Badger found ${displayCandidateTime(time)} at ${theater}. Can you make it? Reply YES or tell me what blocks you.`,
  commitment: (time: string, theater: string, confirmed: number, total: number) =>
    `Locked: ${displayCandidateTime(time)} at ${theater}. ${confirmed}/${total} confirmed.`,
} as const;

export type SpectrumService = "iMessage" | "SMS" | "RCS" | "unknown";

export type SpectrumMessagingConfig = {
  projectId: string;
  projectSecret: string;
  telemetry?: boolean;
};

export type SendMessageInput = {
  to: string;
  body: string;
  sessionId: string;
  participantId: string;
  idempotencyKey?: string;
};

export type SentMessage = {
  messageId: string;
  status: "sent";
  service: SpectrumService;
  from?: string;
};

export type SpectrumInboundMessage = {
  messageId: string;
  from: string;
  body: string;
  timestamp: string;
  service: SpectrumService;
};

export type SpectrumInboundContext = {
  sessionId: string;
  participantId: string;
  participantName?: string;
};

export type InboundMessageIntent = "opt_out" | "confirm" | "decline" | "freeform";

export interface SpectrumTransport {
  sendText(to: string, body: string): Promise<SentMessage>;
  inbound(): AsyncIterable<SpectrumInboundMessage>;
  stop(): Promise<void>;
}

export type SpectrumTransportFactory = (
  config: SpectrumMessagingConfig,
) => Promise<SpectrumTransport>;

type SpectrumSdkUser = {
  id: string;
  address?: string;
  service?: string;
};

type SpectrumSdkMessage = {
  id: string;
  direction: "inbound" | "outbound";
  content: { type: string; text?: string };
  sender?: SpectrumSdkUser;
  timestamp: Date;
};

type SpectrumSdkSpace = {
  phone: string;
  send(body: string): Promise<{ id: string } | undefined>;
};

type SpectrumSdkProvider = {
  user(phone: string): Promise<SpectrumSdkUser>;
  space: { create(user: SpectrumSdkUser): Promise<SpectrumSdkSpace> };
  messages: AsyncIterable<[unknown, SpectrumSdkMessage]>;
};

type SpectrumSdkApp = { stop(): Promise<void> };

function assertE164(phone: string): void {
  if (!E164_PHONE.test(phone)) {
    throw new Error("Spectrum destination must be an E.164 phone number");
  }
}

function asSpectrumService(value: string | undefined): SpectrumService {
  if (value === "iMessage" || value === "SMS" || value === "RCS") return value;
  return "unknown";
}

export const createSpectrumTransport: SpectrumTransportFactory = async (config) => {
  // Spectrum 12.7's generated iMessage declaration currently loses its base
  // provider shape under strict TS 5.9. Keep the compatibility cast here so
  // the rest of Badger remains fully typed against the SDK behavior we use.
  const providerConfig = (imessage.config as unknown as () => unknown)();
  const createApp = Spectrum as unknown as (options: {
    projectId: string;
    projectSecret: string;
    providers: unknown[];
    telemetry: boolean;
  }) => Promise<SpectrumSdkApp>;
  const app = await createApp({
    projectId: config.projectId,
    projectSecret: config.projectSecret,
    providers: [providerConfig],
    telemetry: config.telemetry ?? false,
  });
  const provider = (imessage as unknown as (app: SpectrumSdkApp) => SpectrumSdkProvider)(app);

  return {
    async sendText(to, body) {
      const user = await provider.user(to);
      const space = await provider.space.create(user);
      const message = await space.send(body);
      if (!message) throw new Error("Spectrum did not return an outbound message");

      return {
        messageId: message.id,
        status: "sent",
        service: asSpectrumService(user.service),
        from: space.phone,
      };
    },

    async *inbound() {
      for await (const [, message] of provider.messages) {
        if (
          message.direction !== "inbound" ||
          message.content.type !== "text" ||
          typeof message.content.text !== "string"
        ) {
          continue;
        }
        const from = message.sender?.address ?? message.sender?.id;
        if (!from) continue;

        yield {
          messageId: message.id,
          from,
          body: message.content.text,
          timestamp: message.timestamp.toISOString(),
          service: asSpectrumService(message.sender?.service),
        };
      }
    },

    async stop() {
      await app.stop();
    },
  };
};

export class SpectrumMessagingClient {
  private transportPromise: Promise<SpectrumTransport> | undefined;
  private readonly sends = new Map<string, Promise<SentMessage>>();
  private readonly received = new Set<string>();

  constructor(
    private readonly config: SpectrumMessagingConfig,
    private readonly transportFactory: SpectrumTransportFactory = createSpectrumTransport,
  ) {
    if (!config.projectId || !config.projectSecret) {
      throw new Error("Spectrum projectId and projectSecret are required");
    }
  }

  private transport(): Promise<SpectrumTransport> {
    this.transportPromise ??= this.transportFactory(this.config);
    return this.transportPromise;
  }

  async send(input: SendMessageInput): Promise<SentMessage> {
    assertE164(input.to);
    if (!input.body.trim()) throw new Error("Message body is required");

    const send = async () => (await this.transport()).sendText(input.to, input.body);
    if (!input.idempotencyKey) return send();

    const previous = this.sends.get(input.idempotencyKey);
    if (previous) return previous;

    const pending = send().catch((error: unknown) => {
      this.sends.delete(input.idempotencyKey!);
      throw error;
    });
    this.sends.set(input.idempotencyKey, pending);
    return pending;
  }

  async listenForReplies(input: {
    resolveContext: (
      from: string,
    ) => SpectrumInboundContext | undefined | Promise<SpectrumInboundContext | undefined>;
    emit: EventSink;
    signal?: AbortSignal;
  }): Promise<void> {
    const transport = await this.transport();
    const stop = () => void transport.stop();
    input.signal?.addEventListener("abort", stop, { once: true });

    try {
      for await (const message of transport.inbound()) {
        if (input.signal?.aborted) break;
        if (this.received.has(message.messageId)) continue;
        // One malformed message must never kill the listener for the rest of
        // the demo — log, skip, keep consuming.
        try {
          const context = await input.resolveContext(message.from);
          if (!context) continue;
          this.received.add(message.messageId);
          try {
            await processSpectrumInbound({ message, context, emit: input.emit });
          } catch (error) {
            this.received.delete(message.messageId);
            throw error;
          }
        } catch (error) {
          console.error("[badger.spectrum] inbound message failed", error);
        }
      }
    } finally {
      input.signal?.removeEventListener("abort", stop);
    }
  }

  async stop(): Promise<void> {
    if (this.transportPromise) await (await this.transportPromise).stop();
  }
}

export async function sendBadgerMessage(
  client: SpectrumMessagingClient,
  input: SendMessageInput,
  emit: EventSink,
): Promise<SentMessage> {
  const sent = await client.send(input);
  const event: BadgerEvent = {
    id: input.idempotencyKey ?? randomUUID(),
    sessionId: input.sessionId,
    participantId: input.participantId,
    type: "message.sent",
    timestamp: new Date().toISOString(),
    publicMessage: "Message sent",
    privateData: {
      messageId: sent.messageId,
      status: sent.status,
      service: sent.service,
      from: sent.from,
    },
  };
  await emit(event);
  return sent;
}

export function classifyInboundMessage(body: string): InboundMessageIntent {
  const normalized = body.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ");
  // "Yes!" / "nope." — strip trailing punctuation before exact matching.
  const bare = normalized.replace(/[.!?…]+$/, "").trim();
  if (["stop", "stopall", "unsubscribe", "cancel", "end", "quit"].includes(bare)) {
    return "opt_out";
  }
  // A reply naming a day ("Saturday works for me", "can't do Friday") is a
  // counter-offer/constraint, not a yes/no to the current proposal — let the
  // freeform parser turn it into availability instead.
  if (/\b(?:friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b/.test(normalized)) {
    return "freeform";
  }
  if (
    ["no", "n", "nope", "nah", "no thanks", "no thank you", "im out", "i'm out", "count me out", "decline"].includes(bare) ||
    // "No problem" / "no worries" open plenty of confirmations — a leading
    // "no" only counts as a decline when it isn't part of a positive idiom.
    /^(?:no|nope|nah)\b(?!\s*(?:problem|worries|sweat|issue|doubt))/.test(normalized) ||
    /\b(?:can(?:not|'t)|won't)\s+(?:make|do)\b/.test(normalized) ||
    /\b(?:not able to make|doesn't work|does not work)\b/.test(normalized)
  ) return "decline";
  if (
    [
      "yes", "y", "yea", "yeah", "yep", "yup", "sure", "ok", "okay", "confirm", "confirmed",
      "absolutely", "definitely", "perfect", "great", "cool", "deal", "bet", "works", "i'm down",
      "im down", "i am down", "i'm in", "im in", "all good",
    ].includes(bare) ||
    /\b(?:i can make (?:it|that)|that (?:works|should work|will work|is fine)|works? for me|sounds good|count me in|i(?:'m| am) (?:in|down|good|free)|i'll be there|let's do it|see you there|can do|fine by me)\b/.test(normalized)
  ) return "confirm";
  return "freeform";
}

/** Contextual affirmations such as "Friday works" are only confirmations once
 * Badger has proposed a concrete option. During collection, the same words are
 * availability and must remain freeform. */
export function isNaturalConfirmation(body: string): boolean {
  const intent = classifyInboundMessage(body);
  if (intent === 'confirm') return true;
  if (intent !== 'freeform') return false;
  const normalized = body.trim().toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ');
  return /\b(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|tonight|that|it|the plan|the time)\b.*\b(?:works|is good|is fine|should work|will work)\b/.test(normalized);
}

export async function processSpectrumInbound(input: {
  message: SpectrumInboundMessage;
  context: SpectrumInboundContext;
  emit: EventSink;
}): Promise<BadgerEvent> {
  const intent = classifyInboundMessage(input.message.body);
  const event: BadgerEvent = {
    id: `spectrum:${input.message.messageId}:received`,
    sessionId: input.context.sessionId,
    participantId: input.context.participantId,
    type: "message.received",
    timestamp: input.message.timestamp,
    publicMessage:
      intent === "opt_out"
        ? `${input.context.participantName ?? "Participant"} opted out`
        : `${input.context.participantName ?? "Participant"} replied`,
    privateData: {
      messageId: input.message.messageId,
      from: input.message.from,
      body: input.message.body,
      intent,
      service: input.message.service,
    },
  };
  await input.emit(event);
  return event;
}
