import { useState } from 'react';
import { useBadger } from '../store';
import { createDraft, demoDraft, restartSession, sendBadger } from '../actions';
import type { DraftParticipant } from '../fixtures';

const EMPTY_ROW: DraftParticipant = { name: '', phone: '', required: true };

export function LaunchOverlay({ count }: { count: number }) {
  return (
    <div className="overlay">
      <div className="overlay-dot">🦡</div>
      <div className="overlay-text">Contacting {count} people…</div>
    </div>
  );
}

function Wordmark() {
  return (
    <span className="wordmark">
      🦡 <b>BADGER</b>
    </span>
  );
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
        <Wordmark />
        <h1 className="launch-goal">{snap.session.goal}</h1>
        <div className="launch-people">
          {snap.session.participants.map((p) => (
            <span key={p.id} className="pill pill-muted">
              {p.name}
              {p.required ? '' : ' · optional'}
            </span>
          ))}
        </div>
        <button className="send-badger" onClick={() => void sendBadger()}>
          Send Badger
        </button>
        <button className="launch-back" onClick={restartSession}>
          ← start over
        </button>
        {snap.error && <div className="create-error">{snap.error}</div>}
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
    <div className="create">
      <header className="create-header">
        <Wordmark />
        <button className="btn btn-ghost" onClick={loadDemo}>
          Load demo scenario
        </button>
      </header>

      <div className="create-body">
        <h1 className="create-title">What do you want your group to commit to?</h1>
        <input
          className="goal-input"
          placeholder="See The Odyssey this weekend"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          autoFocus
        />

        <div className="section-label">Your name</div>
        <div className="participant-row" style={{ gridTemplateColumns: '1fr' }}>
          <input
            placeholder="Host name"
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
          />
        </div>

        <div className="section-label" style={{ marginTop: 24 }}>
          Participants
        </div>
        {rows.map((row, i) => (
          <div className="participant-row" key={i}>
            <input
              placeholder="Name"
              value={row.name}
              onChange={(e) => updateRow(i, { name: e.target.value })}
            />
            <input
              placeholder="Phone"
              type="tel"
              value={row.phone}
              onChange={(e) => updateRow(i, { phone: e.target.value })}
            />
            <label className="required-toggle">
              <input
                type="checkbox"
                checked={row.required}
                onChange={(e) => updateRow(i, { required: e.target.checked })}
              />
              required
            </label>
            <button
              className="row-remove"
              onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
              aria-label={`Remove participant ${i + 1}`}
            >
              ×
            </button>
          </div>
        ))}

        <div className="create-actions">
          <button
            className="btn btn-ghost"
            onClick={() => setRows((prev) => [...prev, { ...EMPTY_ROW }])}
          >
            + Add participant
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={() => void submit()}>
            Create Badger
          </button>
        </div>
        {snap.error && <div className="create-error">{snap.error}</div>}
      </div>
    </div>
  );
}
