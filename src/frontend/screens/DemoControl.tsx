import { useEffect, useRef, useState } from 'react';
import { openControlChannel, type DemoCommand, type MirrorState, type PresetId } from '../channel';
import { CHECKPOINTS, type Checkpoint } from '../scenario';

/**
 * Hidden operator console at /demo-control. Open the main app in one window
 * and this in another; commands travel over a BroadcastChannel. This is the
 * safety net that keeps one carrier failure from killing the demo.
 */
export default function DemoControl() {
  const [state, setState] = useState<MirrorState | null>(null);
  const [connected, setConnected] = useState(false);
  const sendRef = useRef<(command: DemoCommand) => void>(() => undefined);

  useEffect(() => {
    const channel = openControlChannel((mirrorState) => {
      setState(mirrorState);
      setConnected(true);
    });
    sendRef.current = channel.send;
    return () => {
      channel.close();
    };
  }, []);

  const send = (command: DemoCommand) => sendRef.current(command);
  const preset = (id: PresetId, participantId?: string) =>
    send({ cmd: 'preset', preset: id, participantId });

  return (
    <div className="console">
      <div className="console-mast">
        <h1>Badger — operator console</h1>
        <span className="console-tag">never on the projector</span>
      </div>
      <p className="console-sub">
        Drives the main window over a BroadcastChannel. Open the app (/) in another tab of this
        browser.
      </p>

      {!connected && <div className="console-warn">No app window detected — open / first.</div>}

      {state && (
        <div className="console-status">
          <span className={`chip ${state.mode === 'mock' ? '' : 'is-ink'}`}>
            {state.mode === 'mock' ? 'rehearsal (mock)' : 'live backend'}
          </span>
          <span className="chip">phase: {state.phase}</span>
          {state.mode === 'mock' && (
            <span className="chip">
              {state.playing ? '▶ playing' : '⏸ paused'} · step {state.stepIndex}/
              {state.totalSteps || '—'}
              {state.nextCheckpoint ? ` · next: ${state.nextCheckpoint}` : ''}
            </span>
          )}
          {state.conflictActive && <span className="chip is-hot">conflict active</span>}
        </div>
      )}

      <div className="console-section">
        <h2 className="console-h">Session</h2>
        <div className="console-row">
          <button className="btn btn-primary" onClick={() => send({ cmd: 'load-demo' })}>
            Load demo scenario
          </button>
          <button className="btn btn-primary" onClick={() => send({ cmd: 'send-badger' })}>
            Send Badger
          </button>
          <button className="btn btn-ghost" onClick={() => preset('restart')}>
            Restart session
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => send({ cmd: 'set-mode', mode: state?.mode === 'mock' ? 'live' : 'mock' })}
          >
            Switch to {state?.mode === 'mock' ? 'live' : 'mock'} mode
          </button>
        </div>
      </div>

      <div className="console-section">
        <h2 className="console-h">Script control (mock mode)</h2>
        <div className="console-row">
          <button className="btn btn-ghost" onClick={() => send({ cmd: 'play' })}>
            ▶ Play
          </button>
          <button className="btn btn-ghost" onClick={() => send({ cmd: 'pause' })}>
            ⏸ Pause
          </button>
        </div>
        <div className="console-row">
          {CHECKPOINTS.map((checkpoint: Checkpoint) => (
            <button
              key={checkpoint}
              className="btn btn-ghost"
              onClick={() => send({ cmd: 'skip-to', checkpoint })}
            >
              ⇥ {checkpoint}
            </button>
          ))}
        </div>
      </div>

      <div className="console-section">
        <h2 className="console-h">Story beats</h2>
        <div className="console-row">
          <button className="btn btn-ghost" onClick={() => preset('trigger-conflict')}>
            Trigger conflict
          </button>
          <button className="btn btn-ghost" onClick={() => preset('resolve-conflict')}>
            Resolve conflict
          </button>
          <button className="btn btn-ghost" onClick={() => preset('skip-to-final')}>
            Skip to final plan
          </button>
        </div>
      </div>

      <div className="console-section">
        <h2 className="console-h">Participants</h2>
        {(state?.participants ?? []).map((p) => (
          <div className="console-participant" key={p.id}>
            <strong>
              {p.name}
              {p.required ? '' : ' (optional)'}
            </strong>
            <span className="chip">{p.status}</span>
            <span className="console-row">
              <button className="btn btn-ghost" onClick={() => preset('inject-preferences', p.id)}>
                Inject prefs
              </button>
              <button className="btn btn-ghost" onClick={() => preset('missed-call', p.id)}>
                Missed call
              </button>
              <button className="btn btn-ghost" onClick={() => preset('sms-reply', p.id)}>
                SMS reply
              </button>
              <button className="btn btn-ghost" onClick={() => preset('confirm-participant', p.id)}>
                Confirm
              </button>
            </span>
          </div>
        ))}
        {!state?.participants.length && (
          <span className="console-sub">No session yet — load the demo scenario.</span>
        )}
      </div>

      {state?.error && <div className="console-error">⚠ {state.error}</div>}
    </div>
  );
}
