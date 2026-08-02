import assert from "node:assert/strict";
import test from "node:test";
import { CartesiaClient, requestBadgerCall } from "../src/voice/cartesia.js";
import {
  CartesiaWebhookProcessor,
  WebhookDeduplicator,
} from "../src/voice/webhooks.js";
import {
  SpectrumMessagingClient,
  classifyInboundMessage,
  sendBadgerMessage,
  type SpectrumInboundMessage,
  type SpectrumTransportFactory,
} from "../src/voice/spectrum.js";
import type { BadgerEvent, CallMetadata } from "../src/shared/types.js";

const metadata: CallMetadata = {
  sessionId: "session_123",
  participantId: "participant_456",
  participantName: "Alex",
  hostName: "Kaustubh",
  goal: "See The Odyssey this weekend",
};

test("Cartesia call uses the current API contract and emits call.requested", async () => {
  let request: { url: string; init: RequestInit | undefined } | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(
      JSON.stringify({ calls: [{ number: "+14155550100", agent_call_id: "call_123" }] }),
      { status: 200 },
    );
  };
  const client = new CartesiaClient({
    apiKey: "secret",
    agentId: "agent_123",
    fromNumberId: "phone_number_123",
    fetch: fakeFetch,
  });
  const events: BadgerEvent[] = [];

  const result = await requestBadgerCall(
    client,
    { to: "+14155550100", metadata, idempotencyKey: "call-key" },
    (event) => {
      events.push(event);
    },
  );

  assert.equal(result.agentCallId, "call_123");
  assert.equal(request?.url, "https://api.cartesia.ai/agents/calls");
  assert.equal(new Headers(request?.init?.headers).get("Cartesia-Version"), "2026-03-01");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    from_number_id: "phone_number_123",
    agent_id: "agent_123",
    ringing_timeout_seconds: 30,
    outbound_calls: [{ to_number: "+14155550100", metadata }],
  });
  assert.equal(events[0]?.type, "call.requested");
});

test("Cartesia completed webhook emits a structured preference result once", async () => {
  const events: BadgerEvent[] = [];
  const processor = new CartesiaWebhookProcessor({
    webhookSecret: "webhook-secret",
    emit: (event) => {
      events.push(event);
    },
  });
  const body = {
    type: "call_completed",
    call_id: "call_123",
    webhook_request_id: "request_123",
    timestamp: "2026-08-01T10:00:00.000Z",
    call: {
      metadata,
      end_reason: "agent_hangup",
      transcript: [
        {
          role: "assistant",
          text: "Thanks!",
          tool_calls: [
            {
              function: {
                name: "submit_preferences",
                arguments: JSON.stringify({
                  participantId: "ignored_from_model",
                  availability: ["friday_after_8", "saturday_afternoon"],
                  hardVetoes: ["saturday_evening"],
                  preferences: ["imax", "closer_to_sf"],
                  flexibility: 0.7,
                  summary: "Available Friday after 8 or Saturday afternoon. Prefers IMAX.",
                }),
              },
            },
          ],
        },
      ],
    },
  };

  const first = await processor.process("webhook-secret", body);
  const retry = await processor.process("webhook-secret", body);

  assert.deepEqual(
    first.events.map((event) => event.type),
    ["call.completed", "preferences.received"],
  );
  assert.equal(
    (first.events[1]?.privateData.preferences as { participantId: string }).participantId,
    metadata.participantId,
  );
  assert.equal(retry.duplicate, true);
  assert.equal(events.length, 2);
});

test("Cartesia webhook rejects the wrong secret before claiming dedupe id", async () => {
  const dedupe = new WebhookDeduplicator();
  const processor = new CartesiaWebhookProcessor({
    webhookSecret: "right",
    deduplicator: dedupe,
    emit: () => undefined,
  });
  const body = {
    type: "call_started",
    call_id: "call_123",
    webhook_request_id: "request_123",
    call: { metadata },
  };

  await assert.rejects(processor.process("wrong", body), /Invalid Cartesia webhook secret/);
  assert.equal((await processor.process("right", body)).duplicate, false);
});

test("Cartesia webhook remains retryable after a transient processing failure", async () => {
  let shouldFail = true;
  const processor = new CartesiaWebhookProcessor({
    webhookSecret: "right",
    emit: () => {
      if (shouldFail) throw new Error("event store unavailable");
    },
  });
  const body = {
    type: "call_started",
    call_id: "call_retry",
    webhook_request_id: "request_retry",
    call: { metadata },
  };

  await assert.rejects(processor.process("right", body), /event store unavailable/);
  shouldFail = false;
  assert.equal((await processor.process("right", body)).duplicate, false);
});

test("Cartesia turn webhook reuses metadata captured when the call started", async () => {
  const events: BadgerEvent[] = [];
  const processor = new CartesiaWebhookProcessor({
    webhookSecret: "right",
    emit: (event) => {
      events.push(event);
    },
  });

  await processor.process("right", {
    type: "call_started",
    call_id: "call_with_turn",
    webhook_request_id: "request_started",
    call: { metadata },
  });
  await processor.process("right", {
    type: "call_turn",
    call_id: "call_with_turn",
    webhook_request_id: "request_turn",
    turn: { id: 1, role: "user", text: "private transcript text" },
  });

  assert.equal(events[1]?.type, "call.turn");
  assert.equal(events[1]?.participantId, metadata.participantId);
  assert.doesNotMatch(JSON.stringify(events[1]), /private transcript text/);
});

test("Spectrum client sends once per idempotency key and emits a normalized event", async () => {
  let sends = 0;
  const factory: SpectrumTransportFactory = async () => ({
    async sendText(to, body) {
      sends += 1;
      assert.equal(to, "+14155550100");
      assert.equal(body, "Hello from Badger");
      return {
        messageId: "spectrum-message-123",
        status: "sent",
        service: "iMessage",
        from: "+14155550999",
      };
    },
    async *inbound() {},
    async stop() {},
  });
  const client = new SpectrumMessagingClient(
    { projectId: "project_123", projectSecret: "secret" },
    factory,
  );
  const events: BadgerEvent[] = [];
  const input = {
    to: "+14155550100",
    body: "Hello from Badger",
    sessionId: "session_123",
    participantId: "participant_456",
    idempotencyKey: "opening-message",
  };

  const result = await sendBadgerMessage(client, input, (event) => {
    events.push(event);
  });
  await client.send(input);

  assert.equal(result.messageId, "spectrum-message-123");
  assert.equal(sends, 1);
  assert.equal(events[0]?.type, "message.sent");
  assert.equal(events[0]?.privateData.service, "iMessage");
});

test("Spectrum replies are correlated and normalized", async () => {
  const inbound: SpectrumInboundMessage = {
    messageId: "spectrum-message-456",
    from: "+14155550100",
    body: "YES",
    timestamp: "2026-08-01T10:05:00.000Z",
    service: "iMessage",
  };
  const factory: SpectrumTransportFactory = async () => ({
    async sendText() {
      throw new Error("not used");
    },
    async *inbound() {
      yield inbound;
      yield inbound;
    },
    async stop() {},
  });
  const client = new SpectrumMessagingClient(
    { projectId: "project_123", projectSecret: "secret" },
    factory,
  );
  const events: BadgerEvent[] = [];

  await client.listenForReplies({
    resolveContext: (from) => (from === inbound.from ? metadata : undefined),
    emit: (event) => {
      events.push(event);
    },
  });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "message.received");
  assert.equal(events[0]?.privateData.body, "YES");
  assert.equal(events[0]?.privateData.intent, "confirm");
  assert.equal(classifyInboundMessage(" stop "), "opt_out");
});
