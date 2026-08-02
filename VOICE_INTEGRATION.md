# Badger phone and messaging integration

Engineer 1's module keeps Cartesia voice and Photon Spectrum messaging behind small adapters.

## Cartesia setup

1. Provision a Cartesia-managed number, assign it to the Badger agent, and copy its phone-number ID to `CARTESIA_FROM_NUMBER_ID`. Spectrum handles messages separately.
2. Deploy `cartesia-agent/` with `cartesia init && cartesia deploy`. Set `OPENAI_API_KEY`, `BADGER_BACKEND_URL`, and `BADGER_TOOL_SECRET` using `cartesia env set`. The TypeScript `BADGER_AGENT_PROMPT` and `SUBMIT_PREFERENCES_TOOL` exports document the equivalent backend contract.
3. The deployed agent's `submit_preferences` tool posts the call's trusted `sessionId` and `participantId` metadata to `POST /internal/preferences`. The backend verifies `BADGER_TOOL_SECRET`, records the preferences, evaluates the group, and triggers the next real message.
4. Register `POST https://<public-host>/webhooks/cartesia`, set a random secret, and attach that webhook to the agent. The implemented route verifies `x-webhook-secret` and passes the JSON envelope to `CartesiaWebhookProcessor.process`.
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

`CartesiaWebhookProcessor` verifies the shared secret before processing, deduplicates Cartesia's stable `webhook_request_id`, and remembers metadata by call ID so turn-only events remain correlated. Badger persists outbound call metadata in SQLite for restart-safe lookup. It deliberately keeps raw transcript text out of public events.

Spectrum Cloud uses a live SDK connection for inbound replies, so it does not need a Twilio-style inbound route in this integration. `resolveContext` must look up the active participant by the sender's E.164 number. Store normalized events idempotently using their deterministic event IDs.

Cartesia's documented lifecycle currently begins at `call_started` (the callee answered); it does not document a ringing event. The processor accepts a forward-compatible `call_ringing` event if Cartesia sends one, but the dashboard should keep `call.requested` as “Calling…” until `call.started` instead of claiming a phone is ringing without provider evidence.

## Implemented backend wiring

```ts
const communications = createConfiguredCommunications({ sessions, events, workflow });
await communications?.start();
await communications?.contact(session);
```

`LiveCommunications` sends opening messages, waits `BADGER_CALL_DELAY_MS`, staggers calls by `BADGER_CALL_STAGGER_MS`, persists call correlation, consumes Cartesia webhooks and Spectrum replies, sends missed-call fallbacks, targets one blocker, broadcasts the proposal, and sends the final commitment.

In live mode, Sail is a required multi-turn coordinator. Each session's complete Responses conversation is stored in SQLite and resent on every turn. Sail emits one strict `coordinate_group` tool call; deterministic code validates its action, candidate, and participant before messaging, then appends a `function_call_output` describing the real execution result. A restart reloads the same conversation rather than creating a stateless planner turn.

All participants must have consented before invoking either provider.

The Free and Pro Spectrum plans use shared managed lines, so different participants may see different sender numbers. Badger uses one-to-one conversations; creating group chats requires a dedicated Spectrum line.
