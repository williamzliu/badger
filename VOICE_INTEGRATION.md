# Badger phone and messaging integration

Engineer 1's module keeps Cartesia voice and Photon Spectrum messaging behind small adapters.

## Cartesia setup

1. Provision a Cartesia-managed number, assign it to the Badger agent, and copy its phone-number ID to `CARTESIA_FROM_NUMBER_ID`. Spectrum handles messages separately.
2. Deploy `cartesia-agent/` with `cartesia init && cartesia deploy`. Set `OPENAI_API_KEY`, `BADGER_BACKEND_URL`, and `BADGER_TOOL_SECRET` using `cartesia env set`. The TypeScript `BADGER_AGENT_PROMPT` and `SUBMIT_PREFERENCES_TOOL` exports document the equivalent backend contract.
3. The deployed agent's `submit_preferences` tool posts the call's trusted `sessionId` and `participantId` metadata to `POST /internal/preferences`. The backend handler should verify `BADGER_TOOL_SECRET` when configured, remove `sessionId` from the body, and call `processSubmittedPreferences`.
4. Register `POST https://<public-host>/webhooks/cartesia`, set a random secret, and attach that webhook to the agent. Pass the received `x-webhook-secret` header and JSON body to `CartesiaWebhookProcessor.process`.
5. Create a Photon Spectrum project and set `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET`. Keep one `SpectrumMessagingClient` alive while the backend runs and call `listenForReplies`. Treat the normalized `opt_out` intent as a hard stop: never message or call that participant again.

Every call must include this metadata:

```json
{
  "sessionId": "session_123",
  "participantId": "participant_456",
  "participantName": "Alex",
  "hostName": "Kaustubh",
  "goal": "See The Odyssey this weekend"
}
```

`CartesiaWebhookProcessor` verifies the shared secret before processing, deduplicates `webhook_request_id`, and remembers metadata by call ID so turn-only events remain correlated. For multi-instance or restart-safe deployment, provide `lookupMetadata` backed by the backend's call table. It deliberately keeps raw transcript text out of public events.

Spectrum Cloud uses a live SDK connection for inbound replies, so it does not need a Twilio-style inbound route in this integration. `resolveContext` must look up the active participant by the sender's E.164 number. Store normalized events idempotently using their deterministic event IDs.

Cartesia's documented lifecycle currently begins at `call_started` (the callee answered); it does not document a ringing event. The processor accepts a forward-compatible `call_ringing` event if Cartesia sends one, but the dashboard should keep `call.requested` as “Calling…” until `call.started` instead of claiming a phone is ringing without provider evidence.

## Minimal backend wiring

```ts
const cartesia = new CartesiaClient({
  apiKey: process.env.CARTESIA_API_KEY!,
  agentId: process.env.CARTESIA_AGENT_ID!,
  fromNumberId: process.env.CARTESIA_FROM_NUMBER_ID!,
});

const spectrum = new SpectrumMessagingClient({
  projectId: process.env.SPECTRUM_PROJECT_ID!,
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
});

void spectrum.listenForReplies({
  resolveContext: (phone) => activeParticipantByPhone(phone),
  emit: appendEvent,
});

await sendBadgerMessage(spectrum, {
  to: participant.phone,
  body: MESSAGE_COPY.opening(session.hostName, session.goal),
  sessionId: session.id,
  participantId: participant.id,
  idempotencyKey: `${session.id}:${participant.id}:opening-message`,
}, appendEvent);

await requestBadgerCall(cartesia, {
  to: participant.phone,
  metadata: {
    sessionId: session.id,
    participantId: participant.id,
    participantName: participant.name,
    hostName: session.hostName,
    goal: session.goal,
  },
  idempotencyKey: `${session.id}:${participant.id}:initial-call`,
}, appendEvent);
```

Stagger calls by at least one second. All participants must have consented before invoking either provider.

The Free and Pro Spectrum plans use shared managed lines, so different participants may see different sender numbers. Badger uses one-to-one conversations; creating group chats requires a dedicated Spectrum line.
