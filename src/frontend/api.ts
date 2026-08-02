import type { Preferences, Session } from '../shared/types';
import { badger, type PublicEventLike } from './store';
import type { DraftInput } from './fixtures';

const SESSION_KEY = 'badger.sessionId';
let source: EventSource | null = null;
let refetchTimer: number | null = null;

async function http<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let message = `${method} ${url} → ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function health(): Promise<{ ok: boolean; live: boolean }> {
  return http('GET', '/health');
}

export function storedSessionId(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

function requireSessionId(): string {
  const id = storedSessionId();
  if (!id) throw new Error('No active session — create one first');
  return id;
}

export async function createSession(input: DraftInput): Promise<Session> {
  const created = await http<Session>('POST', '/sessions', {
    hostName: input.hostName,
    goal: input.goal,
  });
  for (const participant of input.participants) {
    await http('POST', `/sessions/${created.id}/participants`, participant);
  }
  localStorage.setItem(SESSION_KEY, created.id);
  const full = await http<Session>('GET', `/sessions/${created.id}`);
  badger.applySession(full);
  return full;
}

export async function startSession(): Promise<void> {
  const id = requireSessionId();
  connectEvents(id);
  const session = await http<Session>('POST', `/sessions/${id}/start`, {});
  badger.applySession(session);
  scheduleRefetch();
}

export function connectEvents(sessionId: string) {
  disconnect();
  source = new EventSource(`/sessions/${sessionId}/events`);
  source.onmessage = (message) => {
    try {
      badger.applyEvent(JSON.parse(message.data) as PublicEventLike);
      scheduleRefetch();
    } catch {
      /* ignore malformed frames */
    }
  };
  // EventSource reconnects automatically; replayed events are deduped by id.
}

export function disconnect() {
  source?.close();
  source = null;
}

/**
 * Events are sanitized (no participant attribution), so the session object is
 * the source of truth: any event triggers one debounced authoritative refetch.
 */
function scheduleRefetch() {
  if (refetchTimer !== null) return;
  refetchTimer = window.setTimeout(async () => {
    refetchTimer = null;
    const id = storedSessionId();
    if (!id) return;
    try {
      badger.applySession(await http<Session>('GET', `/sessions/${id}`));
    } catch {
      /* transient — next event retries */
    }
  }, 250);
}

/** Reload resilience: rejoin a live session mid-demo. */
export async function resume(): Promise<boolean> {
  const id = storedSessionId();
  if (!id) return false;
  try {
    const session = await http<Session>('GET', `/sessions/${id}`);
    // A finished session from an earlier run should not reopen on the finale
    // screen — start fresh instead.
    if (session.status === 'COMMITTED' || session.status === 'CANCELLED') {
      localStorage.removeItem(SESSION_KEY);
      return false;
    }
    badger.applySession(session);
    if (session.status !== 'DRAFT') connectEvents(id);
    return true;
  } catch {
    localStorage.removeItem(SESSION_KEY);
    return false;
  }
}

/** Fetch the authoritative session snapshot (also applied to the store). */
export async function fetchSession(): Promise<Session | null> {
  const id = storedSessionId();
  if (!id) return null;
  try {
    const session = await http<Session>('GET', `/sessions/${id}`);
    badger.applySession(session);
    return session;
  } catch {
    return null;
  }
}

/** Best-effort stop for the live session so no further calls/texts fire. */
export async function cancelSession(): Promise<void> {
  const id = storedSessionId();
  if (!id) return;
  try {
    await http('POST', `/sessions/${id}/cancel`, {});
  } catch {
    /* already finished, or backend unreachable — clearing locally regardless */
  }
}

export function clearSession() {
  disconnect();
  localStorage.removeItem(SESSION_KEY);
}

export async function injectPreferences(participantId: string, preferences: Preferences): Promise<void> {
  const sessionId = requireSessionId();
  const secret = localStorage.getItem('badger.toolSecret');
  if (!secret) {
    try {
      await http('POST', '/internal/demo/inject', { sessionId, participantId, ...preferences });
    } catch (error) {
      // The backend 404s this route when live providers are active or
      // BADGER_DEMO_MODE isn't set — explain instead of "Not found".
      if ((error as Error).message.includes('Not found')) {
        throw new Error(
          'Demo injection is off (live providers active or BADGER_DEMO_MODE unset) — preferences must come from real calls, or set badger.toolSecret to use /internal/preferences',
        );
      }
      throw error;
    }
    scheduleRefetch();
    return;
  }
  const response = await fetch('/internal/preferences', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify({ sessionId, participantId, ...preferences }),
  });
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Preference injection is locked — run localStorage.setItem('badger.toolSecret', <BADGER_TOOL_SECRET>) in this browser",
      );
    }
    let message = `POST /internal/preferences → ${response.status}`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  scheduleRefetch();
}

export async function confirmParticipant(participantId: string): Promise<void> {
  const sessionId = requireSessionId();
  await http('POST', `/sessions/${sessionId}/participants/${participantId}/confirm`, {});
  scheduleRefetch();
}
