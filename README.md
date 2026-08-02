# 🦡 Badger

You don't ask the group. You send Badger.

Badger coordinates a group commitment (for example, “See The Odyssey this weekend”) by messaging and calling each participant, collecting private constraints, resolving conflicts, and landing on **4/4 committed**.

## Architecture

- **Cartesia** provisions the US phone number and handles calls, transcription, speech, and interruptions.
- **OpenAI** drives each short one-person voice interview and produces structured preferences.
- **Photon Spectrum** sends and receives one-to-one iMessage, with managed SMS/RCS fallback.
- **Sail** is the long-lived group coordinator. Badger persists its full Responses conversation per session, including state updates, strict tool calls, and execution outcomes.
- **The Fastify backend** compares constraints, chooses the plan, and owns commitment; AI never changes group state by itself.

## Local setup

Use Node.js 22 or newer.

```bash
cd /Users/kaustubhbhal/badger/badger
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
- `SAIL_API_KEY` is required in live mode. `SAIL_MODEL` defaults to `zai-org/GLM-5.2-FP8` with the low-latency `asap` window.
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

With live mode on, `POST /sessions/:id/start` sends every opening message, schedules staggered calls, and keeps the Spectrum reply stream running. Sail then chooses `REQUEST_FLEXIBILITY`, `PROPOSE_PLAN`, and `COMMIT_PLAN` actions across one persisted conversation. The backend validates the selected candidate and target before executing every action. A missing live credential—including Sail—fails startup with the exact variable name instead of silently running a fake path.

## Frontend

- `/` is the stage app: create → Send Badger → live coordination → proposal → 4/4 committed.
- `/demo-control` is the operator console. Open it in a second tab of the same browser and keep it off the projector.

The console supports two modes:

- **mock** (default) plays the full demo arc locally.
- **live** uses the backend REST API and `GET /sessions/:id/events` SSE stream.

The operator's scripted preference injection only exists when `BADGER_DEMO_MODE=true`. Cartesia's deployed agent uses the authenticated `/internal/preferences` route in a real run.

Demo participant defaults live in `src/frontend/fixtures.ts`. Candidate fixtures live in `src/backend/mocks.ts` and `src/frontend/fixtures.ts`; keep their `slot` values aligned.

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
3. Verify each recipient gets an iMessage, then a Cartesia call roughly 10 seconds later.
4. Answer the calls and give constraints. The Cartesia agent posts structured preferences to the backend.
5. Reply `YES` to the targeted flexibility question or proposal. Spectrum replies advance the real state machine.
6. Watch the stage app reach **4/4 committed** and verify everyone receives the locked-plan message.

Use consenting test recipients only. Cartesia-managed numbers currently support US outbound calls, and Photon project access still applies to message recipients.

## Privacy rule

The shared display renders `publicMessage` only. Raw transcripts, phone numbers, provider details, and private constraints belong in `privateData` and are removed from public SSE events.
