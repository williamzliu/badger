import { useState } from 'react';
import { useBadger } from '../store';
import { createDraft, demoDraft, restartSession, sendBadger } from '../actions';
import type { DraftParticipant } from '../fixtures';
import Masthead from '../components/Masthead';

const EMPTY_ROW: DraftParticipant = { name: '', phone: '', required: true };

export function LaunchOverlay({ count }: { count: number }) {
  return (
    <div className="overlay">
      <span className="livedot" />
      <div className="overlay-text">Contacting {count} people…</div>
    </div>
  );
}

/** "With Alex, Priya, Jordan and Sam." */
function withLine(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `With ${names[0]}.`;
  return `With ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}.`;
}

export default function CreateScreen() {
  const snap = useBadger();
  const [hostName, setHostName] = useState('');
  const [goal, setGoal] = useState('');
  const [rows, setRows] = useState<DraftParticipant[]>([
    { ...EMPTY_ROW },
    { ...EMPTY_ROW },
    { ...EMPTY_ROW },
  ]);
  const [busy, setBusy] = useState(false);

  // A draft session exists → launch stage.
  if (snap.session) {
    return (
      <div className="launch">
        <span className="kicker">The plan</span>
        <h1 className="launch-goal">{snap.session.goal}</h1>
        <div className="launch-with">{withLine(snap.session.participants.map((p) => p.name))}</div>
        <button className="btn-ink" style={{ fontSize: 17, padding: '18px 42px' }} onClick={() => void sendBadger()}>
          Send Badger →
        </button>
        <button className="link launch-back" onClick={restartSession}>
          Start over
        </button>
        {snap.error && <div className="form-error">{snap.error}</div>}
      </div>
    );
  }

  const valid =
    goal.trim().length > 0 &&
    hostName.trim().length > 0 &&
    rows.some((r) => r.name.trim() && r.phone.trim());

  const updateRow = (index: number, patch: Partial<DraftParticipant>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await createDraft({
        hostName: hostName.trim(),
        goal: goal.trim(),
        participants: rows
          .filter((r) => r.name.trim() && r.phone.trim())
          .map((r) => ({ ...r, name: r.name.trim(), phone: r.phone.trim() })),
      });
    } catch {
      /* error already surfaced in store */
    } finally {
      setBusy(false);
    }
  };

  const loadDemo = () => {
    const demo = demoDraft();
    setHostName(demo.hostName);
    setGoal(demo.goal);
    setRows(demo.participants.map((p) => ({ ...p })));
  };

  return (
    <div className="page">
      <Masthead kicker="Group coordination, delegated" />
      <div className="create-body">
        <h1 className="create-title">What should your group commit&nbsp;to?</h1>
        <input
          className="field goal-field"
          placeholder="See The Odyssey this weekend"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          autoFocus
        />

        <label className="form-label kicker" htmlFor="host">
          Your name
        </label>
        <input
          id="host"
          className="field host-field"
          placeholder="Host"
          value={hostName}
          onChange={(e) => setHostName(e.target.value)}
        />

        <div className="form-label kicker">Participants</div>
        <div className="p-table">
          {rows.map((row, i) => (
            <div className="p-row" key={i}>
              <input
                className="field"
                placeholder="Name"
                value={row.name}
                onChange={(e) => updateRow(i, { name: e.target.value })}
              />
              <input
                className="field"
                placeholder="Phone"
                type="tel"
                value={row.phone}
                onChange={(e) => updateRow(i, { phone: e.target.value })}
              />
              <label className="req-toggle smallcaps">
                <input
                  type="checkbox"
                  checked={row.required}
                  onChange={(e) => updateRow(i, { required: e.target.checked })}
                />
                required
              </label>
              <button
                className="p-remove"
                onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                aria-label={`Remove participant ${i + 1}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="create-actions">
          <button className="btn-ink" disabled={!valid || busy} onClick={() => void submit()}>
            Create Badger →
          </button>
          <button className="link" onClick={() => setRows((prev) => [...prev, { ...EMPTY_ROW }])}>
            Add participant
          </button>
          <button className="link" onClick={loadDemo}>
            Load demo scenario
          </button>
        </div>
        {snap.error && <div className="form-error">{snap.error}</div>}
      </div>
    </div>
  );
}
