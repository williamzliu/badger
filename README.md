# 🦡 Badger

You don't ask the group. You send Badger.

Badger coordinates a group commitment ("See The Odyssey this weekend") by texting
and calling every participant, collecting availability and constraints, resolving
the one person blocking consensus, and landing on **4/4 committed**.

## Running

```bash
npm install
npm run dev        # backend (Fastify + SQLite) on :3000
npm run dev:web    # frontend (Vite + React) on :5173, proxies API to :3000
```

## Frontend

- **`/`** — the stage app: create → Send Badger → live coordination → proposal → 4/4 committed.
- **`/demo-control`** — hidden operator console. Open it in a *second tab of the same browser*;
  it drives the main window over a BroadcastChannel. Checkpoint jumps, conflict
  trigger/resolve, per-participant injections, restart. Keep it off the projector.

Two data modes (toggle in the console, persisted in localStorage):

- **mock** (default) — a scripted driver plays the full demo arc locally. No backend needed.
- **live** — talks to the backend REST API and consumes the SSE stream at
  `GET /sessions/:id/events`. Events are sanitized server-side, so the frontend
  refetches `GET /sessions/:id` (debounced) as the source of truth for cards/phase.

Checks: `npm run check` (backend + shared), `npm run check:web` (frontend), `npm run build:web`.

## Privacy rule

The shared display renders `publicMessage` only — never transcripts, never
`privateData`, never who introduced a sensitive constraint.

## Demo fixtures

- Participants/goal prefill: `src/frontend/fixtures.ts` (swap in real phone numbers before the demo).
- Candidate showings: `src/backend/mocks.ts` (backend) and `DEMO_CANDIDATES` in
  `src/frontend/fixtures.ts` (mock mode) — keep `slot` values aligned so live-mode
  injection tells the same story: the last participant is the blocker
  (vetoes Friday, most flexible → the resolver follows up with them).
