# 🦡 Badger

You don't ask the group. You send Badger.

Badger coordinates a group commitment (for example, “See The Odyssey this weekend”) by messaging and calling each participant, collecting private constraints, resolving conflicts, and landing on **4/4 committed**.

## Architecture

- **Cartesia** provisions the US phone number and handles calls, transcription, speech, and interruptions.
- **OpenAI** drives each short one-person voice interview and provides sourced web research through a client-side tool that Sail can invoke.
- **Photon Spectrum** sends and receives one-to-one iMessage, with managed SMS/RCS fallback.
- **Sail** is the long-lived group coordinator. It ranks sourced options, reasons about tradeoffs and conflict strategy, and continuously reviews the authoritative group state. Badger persists its complete Responses conversation, tool calls, replies, and outcomes.
- **The Fastify backend** validates destinations, timing bounds, sourced candidate IDs, hard vetoes, state transitions, idempotency, and final commitment before executing Sail's actions.

## Local setup

Use Node.js 22 or newer.

```bash
cd badger
npm install
cp .env.example .env
npm run dev        # backend on :3000
npm run dev:web    # frontend on :5173, proxying the API to :3000
```

Fill `.env` with the provider credentials you need. Do not commit it.

Important values:

- `CARTESIA_FROM_NUMBER_ID` is the Cartesia phone-number **ID**, not its visible `+1…` number.
- `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` come from Photon project settings.
- `BADGER_TOOL_SECRET` must match the secret accepted by `/internal/preferences`.
- `SAIL_API_KEY` is required in live mode. The demo defaults to Sail's `openai/gpt-oss-120b` with low reasoning. `SAIL_COMPLETION_WINDOW=asap` explicitly selects Sail's lowest-latency queue; background polling tolerates longer inference without blocking the UI, and `SAIL_TIMEOUT_MS` defaults to 45000.
- `OPENAI_API_KEY` is used by the deployed voice agent, option research, and the inbound reply hot path. Research defaults to `gpt-5.4-mini` with no reasoning and a 30-minute cache; set `BADGER_DEFAULT_LOCATION` to the demo group's area.
- Inbound texts use a two-second `gpt-4.1-nano` hot path (`BADGER_FAST_INBOUND_MODEL`, `BADGER_FAST_INBOUND_TIMEOUT_MS`). Every raw reply and chosen action is appended to Sail's persisted conversation, but routine reply latency no longer waits on Sail inference. STOP remains an immediate deterministic opt-out; provider timeouts fall back to the local parser.
- `PUBLIC_BASE_URL` and the deployed agent’s `BADGER_BACKEND_URL` must be public HTTPS URLs for live callbacks.

For a safe UI-only rehearsal, keep:

```dotenv
BADGER_LIVE_MODE=false
BADGER_DEMO_MODE=true
```

For real texts and calls, expose the backend on public HTTPS, then set:

```dotenv
BADGER_LIVE_MODE=true
BADGER_DEMO_MODE=false
PUBLIC_BASE_URL=https://your-public-backend.example
```

With live mode on, Badger starts real sourced research as soon as the draft is created. Starting the session rings participants immediately while research and Sail orchestration continue in parallel. All sourced options are retained, with Sail's choices ranked first. Explicit replies such as “Sunday works” take an instant deterministic path; ambiguous replies use the two-second OpenAI hot path. Every reply and action is appended to the same persisted Sail conversation, and Sail asynchronously reviews each proposal or conflict transition without delaying the call or text already in flight. The backend executes only validated, hard-veto-safe actions. A missing live credential fails startup instead of silently switching to a fake path.

## Frontend

- `/` is the stage app: create → Send Badger → live coordination → proposal → 4/4 committed.
- `/demo-control` is the operator console. Open it in a second tab of the same browser and keep it off the projector.
- The live screen shows Sail's concise research, outreach, and decision summaries in a dedicated reasoning panel. These are public-safe rationales, never hidden chain-of-thought or raw participant constraints.

The console supports two modes:

- **mock** (default) plays the full demo arc locally.
- **live** uses the backend REST API and `GET /sessions/:id/events` SSE stream.

The operator's scripted preference injection only exists when `BADGER_DEMO_MODE=true`. Cartesia's deployed agent uses the authenticated `/internal/preferences` route in a real run.

Demo participant defaults live in `src/frontend/fixtures.ts`. Rehearsal mode derives neutral windows from `src/shared/candidates.ts`; live mode replaces them with researched, sourced options while the opening calls are underway.

## Checks

```bash
npm run check
npm run test
npm run check:web
npm run build:web
```

Provider tests use mocked responses and do not contact real phones.

To send one real Spectrum message to a consenting participant:

```bash
npm run spectrum:smoke -- +14155550100
```

## Deploy the voice agent

The deployable Cartesia Line agent is in `cartesia-agent/`.

```bash
curl -fsSL https://cartesia.sh | sh
exec zsh                    # reload PATH after first install
cd cartesia-agent
cartesia auth login
cartesia init
cartesia env set \
  OPENAI_API_KEY=YOUR_KEY \
  BADGER_LLM_MODEL=gpt-5.4 \
  BADGER_BACKEND_URL=https://your-public-backend.example \
  BADGER_TOOL_SECRET=YOUR_RANDOM_SECRET
cartesia deploy
```

Provision and assign a Cartesia-managed number:

```bash
cartesia phone-numbers provision "Badger Demo" --agent-id YOUR_AGENT_ID
cartesia phone-numbers ls --agent-id YOUR_AGENT_ID
```

Register and attach the backend webhook (you can also do this in the agent's Webhook settings):

```bash
curl -X POST https://api.cartesia.ai/agents/webhooks \
  -H "X-API-Key: $CARTESIA_API_KEY" \
  -H "Cartesia-Version: 2026-03-01" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://YOUR_PUBLIC_HOST/webhooks/cartesia","secret":"YOUR_WEBHOOK_SECRET"}'

curl -X PATCH "https://api.cartesia.ai/agents/$CARTESIA_AGENT_ID" \
  -H "X-API-Key: $CARTESIA_API_KEY" \
  -H "Cartesia-Version: 2026-03-01" \
  -H "Content-Type: application/json" \
  -d '{"webhook_id":"YOUR_WEBHOOK_ID"}'
```

Add every demo recipient as a user in the Photon project before testing. Spectrum rejects destinations that are not allowed for that project.

Outbound calls use `POST https://api.cartesia.ai/agents/calls` and include:

```json
{
  "sessionId": "session_123",
  "participantId": "participant_456",
  "participantName": "Alex",
  "hostName": "Kaustubh",
  "goal": "See The Odyssey this weekend"
}
```

See `VOICE_INTEGRATION.md` for the provider contracts and backend wiring.

## End-to-end test

1. Start the public backend and frontend, then check `GET /health` returns `{"ok":true,"live":true}`.
2. Open `/demo-control`, switch to **live**, create the session, and press **Send Badger**.
3. Watch `Sail is researching real options…`, then verify each recipient receives the channel and timing Sail selected.
4. Answer the calls and give constraints. The Cartesia agent posts structured preferences to the backend.
5. Reply `YES` to the targeted flexibility question or proposal. Spectrum replies advance the real state machine.
6. Watch the stage app reach **4/4 committed** and verify everyone receives the locked-plan message.

Use consenting test recipients only. Cartesia-managed numbers currently support US outbound calls, and Photon project access still applies to message recipients.

## Privacy rule

The shared display renders `publicMessage` only. Raw transcripts, phone numbers, provider details, and private constraints belong in `privateData` and are removed from public SSE events.
