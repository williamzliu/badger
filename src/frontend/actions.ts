import { badger, type Mode } from './store';
import { MockDriver } from './mockDriver';
import * as api from './api';
import { normalizePhone } from './phone';
import {
  BLOCKER_PREFS,
  BLOCKER_RESOLVED_PREFS,
  DEMO_GOAL,
  DEMO_HOST,
  DEMO_HOST_PHONE,
  DEMO_PARTICIPANTS,
  isBlocker,
  prefsFor,
  type DraftInput,
} from './fixtures';
import type { PresetId } from './channel';

export const driver = new MockDriver();

function mode(): Mode {
  return badger.getSnapshot().mode;
}

export function setMode(next: Mode) {
  localStorage.setItem('badger.mode', next);
  localStorage.setItem('badger.mode.operator', next);
  location.reload();
}

export function demoDraft(): DraftInput {
  return {
    hostName: DEMO_HOST,
    hostPhone: DEMO_HOST_PHONE,
    goal: DEMO_GOAL,
    participants: [...DEMO_PARTICIPANTS],
  };
}

export async function createDraft(input: DraftInput): Promise<void> {
  badger.setError(null);
  // The host is a participant too — Badger calls them like everyone else.
  // Dedupe by phone (not name): a participant who happens to share the
  // host's name must not silently drop the host from the group.
  const hostE164 = input.hostPhone ? normalizePhone(input.hostPhone) : null;
  const hostAlreadyListed =
    hostE164 !== null && input.participants.some((p) => normalizePhone(p.phone) === hostE164);
  const participants =
    input.hostPhone && !hostAlreadyListed
      ? [{ name: input.hostName, phone: input.hostPhone, required: true }, ...input.participants]
      : input.participants;
  const full = { ...input, participants };
  try {
    if (mode() === 'mock') driver.createDraft(full);
    else await api.createSession(full);
  } catch (error) {
    badger.setError((error as Error).message);
    throw error;
  }
}

/** Abandon the current draft and return to the create form. */
export function discardDraft() {
  badger.setError(null);
  if (mode() === 'mock') {
    driver.clear();
  } else {
    void api.cancelSession();
    api.clearSession();
  }
  badger.reset();
}

export async function sendBadger(): Promise<void> {
  badger.setError(null);
  if (!badger.getSnapshot().session) {
    badger.setError('No session yet — create one (or Load demo scenario) first');
    return;
  }
  badger.setLaunching(true);
  try {
    if (mode() === 'mock') {
      driver.play();
      window.setTimeout(() => badger.setLaunching(false), 2400);
    } else {
      await api.startSession();
      // The backend has accepted the session and real milestones are already
      // streaming. Show the live timeline instead of hiding it under a timer.
      badger.setLaunching(false);
    }
  } catch (error) {
    badger.setLaunching(false);
    badger.setError((error as Error).message);
  }
}

export function restartSession() {
  badger.setError(null);
  if (mode() === 'mock') {
    driver.restart();
  } else {
    // Actually stop the backend session — an abandoned live session would
    // keep calling and texting real phones.
    void api.cancelSession();
    api.clearSession();
    badger.reset();
  }
}

/**
 * Demo-console presets. In mock mode they drive the scripted driver; in live
 * mode they hit the real backend so a rehearsal can be steered end-to-end.
 */
export async function runPreset(preset: PresetId, participantId?: string): Promise<void> {
  badger.setError(null);
  if (preset === 'restart') {
    restartSession();
    return;
  }
  if (mode() === 'mock') {
    driver.preset(preset, participantId);
    return;
  }
  const session = badger.getSnapshot().session;
  if (!session) {
    badger.setError('No active session');
    return;
  }
  const target =
    session.participants.find((p) => p.id === participantId) ??
    session.participants.find((p) => !p.preferences) ??
    session.participants[session.participants.length - 1];
  try {
    switch (preset) {
      case 'inject-preferences':
        await api.injectPreferences(target.id, prefsFor(session, target));
        break;
      case 'trigger-conflict':
        // Fill everyone in; the blocker's vetoes guarantee no viable slot.
        for (const p of session.participants.filter((x) => !x.preferences)) {
          await api.injectPreferences(p.id, isBlocker(session, p) ? BLOCKER_PREFS : prefsFor(session, p));
        }
        break;
      case 'resolve-conflict':
        await api.injectPreferences(
          session.participants[session.participants.length - 1].id,
          BLOCKER_RESOLVED_PREFS,
        );
        break;
      case 'confirm-participant':
        await api.confirmParticipant(target.id);
        break;
      case 'skip-to-final': {
        // Only required participants gate matching and commitment; the
        // backend 400s confirms for anyone not PROPOSED.
        if (session.status === 'RESOLVING') {
          const blocked = session.participants.find((p) => p.status === 'NEEDS_FOLLOWUP');
          if (blocked) await api.injectPreferences(blocked.id, BLOCKER_RESOLVED_PREFS);
        }
        for (const p of session.participants.filter((x) => x.required && !x.preferences)) {
          await api.injectPreferences(
            p.id,
            isBlocker(session, p) ? BLOCKER_RESOLVED_PREFS : prefsFor(session, p),
          );
        }
        const refreshed = await api.fetchSession();
        for (const p of (refreshed ?? session).participants) {
          if (!p.required || p.status === 'CONFIRMED') continue;
          try {
            await api.confirmParticipant(p.id);
          } catch {
            /* already confirmed or committed — keep going */
          }
        }
        break;
      }
      case 'missed-call':
      case 'sms-reply':
        badger.setError('Live telephony simulation needs engineer 1\'s webhook endpoints — use mock mode');
        break;
    }
  } catch (error) {
    badger.setError((error as Error).message);
  }
}
