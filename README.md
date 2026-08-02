# 🦡 Badger

You don't ask the group. You send Badger.

Badger coordinates a group commitment (for example, “See The Odyssey this weekend”) by messaging and calling each participant, collecting private constraints, resolving conflicts, and landing on **4/4 committed**.

## Architecture

- **Cartesia** provisions the US phone number and handles calls, transcription, speech, and interruptions.
- **OpenAI** drives each short one-person voice interview and produces structured preferences.
- **Photon Spectrum** sends and receives one-to-one iMessage, with managed SMS/RCS fallback.
- **Sail** compares the group’s constraints and recommends a plan or targeted follow-up.
- **The Fastify backend** owns session state and commitment; AI never commits the group by itself.

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
- `PUBLIC_BASE_URL` and the deployed agent’s `BADGER_BACKEND_URL` must be public HTTPS URLs for live callbacks.

## Frontend

- `/` is the stage app: create → Send Badger → live coordination → proposal → 4/4 committed.
- `/demo-control` is the operator console. Open it in a second tab of the same browser and keep it off the projector.

The console supports two modes:

- **mock** (default) plays the full demo arc locally.
- **live** uses the backend REST API and `GET /sessions/:id/events` SSE stream.

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

## Privacy rule

The shared display renders `publicMessage` only. Raw transcripts, phone numbers, provider details, and private constraints belong in `privateData` and are removed from public SSE events.
