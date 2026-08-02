import { badger, type Mode, type UIPhase } from './store';
import { createDraft, demoDraft, driver, restartSession, runPreset, sendBadger, setMode } from './actions';
import type { Checkpoint } from './scenario';

export type PresetId =
  | 'inject-preferences'
  | 'missed-call'
  | 'sms-reply'
  | 'confirm-participant'
  | 'trigger-conflict'
  | 'resolve-conflict'
  | 'skip-to-final'
  | 'restart';

export type DemoCommand =
  | { cmd: 'hello' }
  | { cmd: 'preset'; preset: PresetId; participantId?: string }
  | { cmd: 'play' }
  | { cmd: 'pause' }
  | { cmd: 'skip-to'; checkpoint: Checkpoint }
  | { cmd: 'set-mode'; mode: Mode }
  | { cmd: 'load-demo' }
  | { cmd: 'send-badger' };

export interface MirrorState {
  mode: Mode;
  phase: UIPhase;
  goal: string | null;
  sessionId: string | null;
  playing: boolean;
  stepIndex: number;
  totalSteps: number;
  nextCheckpoint: string | null;
  conflictActive: boolean;
  error: string | null;
  participants: Array<{ id: string; name: string; status: string; required: boolean }>;
}

const CHANNEL = 'badger-demo';

function mirror(): MirrorState {
  const snap = badger.getSnapshot();
  const drv = driver.state();
  return {
    mode: snap.mode,
    phase: snap.phase,
    goal: snap.session?.goal ?? null,
    sessionId: snap.session?.id ?? null,
    playing: drv.playing,
    stepIndex: drv.stepIndex,
    totalSteps: drv.totalSteps,
    nextCheckpoint: drv.nextCheckpoint,
    conflictActive: snap.conflictActive,
    error: snap.error,
    participants: (snap.session?.participants ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      required: p.required,
    })),
  };
}

async function handleCommand(command: DemoCommand) {
  switch (command.cmd) {
    case 'hello':
      break; // state push below covers it
    case 'preset':
      await runPreset(command.preset, command.participantId);
      break;
    case 'play':
      driver.play();
      break;
    case 'pause':
      driver.pause();
      break;
    case 'skip-to':
      driver.skipTo(command.checkpoint);
      break;
    case 'set-mode':
      setMode(command.mode);
      break;
    case 'load-demo':
      await createDraft(demoDraft());
      break;
    case 'send-badger':
      await sendBadger();
      break;
  }
}

/**
 * Main app window: executes commands broadcast from /demo-control and mirrors
 * store state back so the console can render without owning any state.
 */
export function initAppChannel() {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(CHANNEL);
  const push = () => channel.postMessage({ kind: 'state', state: mirror() });
  channel.onmessage = (event) => {
    const message = event.data as DemoCommand | { kind: 'state' };
    if (!message || 'kind' in message) return;
    void handleCommand(message).then(push);
  };
  let pending = false;
  badger.subscribe(() => {
    if (pending) return;
    pending = true;
    window.setTimeout(() => {
      pending = false;
      push();
    }, 100);
  });
  push();
}

/** Demo-console window: sends commands, receives state mirrors. */
export function openControlChannel(onState: (state: MirrorState) => void) {
  const channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (event) => {
    const message = event.data as { kind?: string; state?: MirrorState };
    if (message?.kind === 'state' && message.state) onState(message.state);
  };
  channel.postMessage({ cmd: 'hello' } satisfies DemoCommand);
  return {
    send: (command: DemoCommand) => channel.postMessage(command),
    close: () => channel.close(),
  };
}
