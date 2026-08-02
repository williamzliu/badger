import type { Session } from '../shared/types';
import { badger } from './store';
import { buildScenario, type Checkpoint, type Step } from './scenario';
import { makeDraftSession, prefsFor, type DraftInput } from './fixtures';
import type { PresetId } from './channel';

let eventCounter = 0;

export interface DriverState {
  playing: boolean;
  stepIndex: number;
  totalSteps: number;
  nextCheckpoint: Checkpoint | null;
}

/**
 * Plays the scripted demo against the store through the same two entry points
 * the live SSE path uses (applySession + applyEvent), so every screen behaves
 * identically in both modes.
 */
export class MockDriver {
  private session: Session | null = null;
  private steps: Step[] = [];
  private index = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastDraft: DraftInput | null = null;
  playing = false;

  createDraft(input: DraftInput) {
    this.stopTimer();
    this.playing = false;
    this.lastDraft = input;
    this.session = makeDraftSession(input);
    this.steps = [];
    this.index = 0;
    badger.reset();
    badger.applySession(structuredClone(this.session));
  }

  play() {
    if (!this.session || this.session.status === 'COMMITTED') return;
    this.ensureSteps();
    if (this.index >= this.steps.length) return;
    this.playing = true;
    this.scheduleNext();
    badger.setError(null);
  }

  pause() {
    this.playing = false;
    this.stopTimer();
    this.notify();
  }

  skipTo(checkpoint: Checkpoint) {
    if (!this.session) return;
    this.ensureSteps();
    this.stopTimer();
    while (this.index < this.steps.length) {
      const step = this.steps[this.index];
      this.runStep(step);
      this.index += 1;
      if (step.checkpoint === checkpoint) break;
    }
    if (this.playing) this.scheduleNext();
    else this.notify();
  }

  restart() {
    if (this.lastDraft) this.createDraft(this.lastDraft);
  }

  /** Drop the session entirely (back to the create form). */
  clear() {
    this.stopTimer();
    this.playing = false;
    this.session = null;
    this.steps = [];
    this.index = 0;
  }

  preset(preset: PresetId, participantId?: string) {
    const session = this.session;
    if (!session) return;
    const participant =
      session.participants.find((p) => p.id === participantId) ??
      session.participants.find((p) => !p.preferences) ??
      session.participants[0];
    switch (preset) {
      case 'inject-preferences':
        participant.preferences = prefsFor(session, participant);
        participant.status = 'RESPONDED';
        this.emitAdhoc('preferences.received', `${participant.name}'s availability received`);
        break;
      case 'missed-call':
        if (!participant.preferences) participant.status = 'NEEDS_FOLLOWUP';
        this.emitAdhoc('call.failed', `Couldn't reach ${participant.name} — texting instead`);
        break;
      case 'sms-reply':
        this.emitAdhoc('message.received', `${participant.name} replied by text`);
        break;
      case 'confirm-participant': {
        participant.status = 'CONFIRMED';
        this.emitAdhoc('proposal.confirmed', `${participant.name} confirmed`);
        const required = session.participants.filter((p) => p.required);
        if (session.status === 'PROPOSING' && required.every((p) => p.status === 'CONFIRMED')) {
          session.status = 'COMMITTED';
          this.emitAdhoc('plan.committed', `${required.length}/${required.length} committed`);
        }
        break;
      }
      case 'trigger-conflict':
        this.skipTo('conflict');
        break;
      case 'resolve-conflict':
        this.skipTo('proposal');
        break;
      case 'skip-to-final':
        this.skipTo('committed');
        break;
      case 'restart':
        this.restart();
        break;
    }
  }

  state(): DriverState {
    return {
      playing: this.playing,
      stepIndex: this.index,
      totalSteps: this.steps.length,
      nextCheckpoint:
        this.steps.slice(this.index).find((step) => step.checkpoint)?.checkpoint ?? null,
    };
  }

  private ensureSteps() {
    if (!this.steps.length && this.session) this.steps = buildScenario(this.session);
  }

  private scheduleNext() {
    this.stopTimer();
    if (!this.playing || !this.session) return;
    if (this.index >= this.steps.length) {
      this.playing = false;
      this.notify();
      return;
    }
    const step = this.steps[this.index];
    this.timer = setTimeout(() => {
      this.runStep(step);
      this.index += 1;
      this.scheduleNext();
    }, step.delay);
    this.notify();
  }

  private runStep(step: Step) {
    const session = this.session;
    if (!session) return;
    step.apply?.(session);
    badger.applySession(structuredClone(session));
    badger.applyEvent({
      id: `mock_${++eventCounter}`,
      type: step.type,
      timestamp: new Date().toISOString(),
      publicMessage: step.message(session),
    });
  }

  private emitAdhoc(type: string, publicMessage: string) {
    const session = this.session;
    if (!session) return;
    badger.applySession(structuredClone(session));
    badger.applyEvent({
      id: `mock_${++eventCounter}`,
      type,
      timestamp: new Date().toISOString(),
      publicMessage,
    });
  }

  private stopTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Nudge the store so the demo console's mirror refreshes driver state. */
  private notify() {
    badger.setError(badger.getSnapshot().error);
  }
}
