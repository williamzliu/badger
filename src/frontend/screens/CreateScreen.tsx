import { useState } from 'react';
import { useBadger } from '../store';
import { createDraft, demoDraft, discardDraft, sendBadger } from '../actions';
import type { DraftParticipant } from '../fixtures';
import { normalizePhone, prettyPhone, sanitizePhoneInput } from '../phone';
import Masthead from '../components/Masthead';
import BadgerMark from '../components/BadgerMark';

const EMPTY_ROW: DraftParticipant = { name: '', phone: '', required: true };
const MIN_OTHERS = 2;

export function LaunchOverlay({ count }: { count: number }) {
  return (
    <div className="overlay">
      <span className="overlay-badger">
        <BadgerMark size={64} />
      </span>
      <div className="overlay-text">Contacting {count} people…</div>
    </div>
  );
}

/** "With Sam, Jessica and William — and you." (host is participants[0]) */
function withLine(names: string[]): string {
  const others = names.slice(1);
  if (others.length === 0) return 'Just you so far.';
  if (others.length === 1) return `With ${others[0]} — and you.`;
  return `With ${others.slice(0, -1).join(', ')} and ${others[others.length - 1]} — and you.`;
}

export default function CreateScreen() {
  const snap = useBadger();
  const [hostName, setHostName] = useState('');
  const [hostPhone, setHostPhone] = useState('');
  const [goal, setGoal] = useState('');
  const [rows, setRows] = useState<DraftParticipant[]>([
    { ...EMPTY_ROW },
    { ...EMPTY_ROW },
    { ...EMPTY_ROW },
  ]);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // A draft session exists → launch stage.
  if (snap.session) {
    return (
      <div className="launch">
        <span className="kicker">The plan</span>
        <h1 className="launch-goal">{snap.session.goal}</h1>
        <div className="launch-with">{withLine(snap.session.participants.map((p) => p.name))}</div>
        <button
          className="btn-ink"
          style={{ fontSize: 17, padding: '18px 42px' }}
          onClick={() => void sendBadger()}
        >
          Send Badger →
        </button>
        <button className="link launch-back" onClick={discardDraft}>
          Start over
        </button>
        {snap.error && <div className="form-error">{snap.error}</div>}
      </div>
    );
  }

  const updateRow = (index: number, patch: Partial<DraftParticipant>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const prettify = (index: number) => {
    const row = rows[index];
    if (row && normalizePhone(row.phone)) updateRow(index, { phone: prettyPhone(row.phone) });
  };

  const validate = (): { problems: string[]; complete: DraftParticipant[] } => {
    const found: string[] = [];
    if (!goal.trim()) found.push('Give your group something to commit to.');
    if (!hostName.trim()) found.push('Add your name.');
    if (!normalizePhone(hostPhone)) found.push('Your phone number looks incomplete.');

    const touched = rows.filter((r) => r.name.trim() || r.phone.trim());
    for (const row of touched) {
      if (!row.name.trim()) found.push(`The participant with phone ${row.phone || '—'} needs a name.`);
      else if (!row.phone.trim()) found.push(`${row.name.trim()} needs a phone number.`);
      else if (!normalizePhone(row.phone)) found.push(`${row.name.trim()}'s phone number looks incomplete.`);
    }

    const complete = touched.filter((r) => r.name.trim() && normalizePhone(r.phone));
    if (complete.length < MIN_OTHERS) {
      found.push(`Badger needs at least ${MIN_OTHERS} people besides you — it coordinates groups, not solo trips.`);
    }
    return { problems: found, complete };
  };

  const submit = async () => {
    if (busy) return;
    const { problems: found, complete } = validate();
    setProblems(found);
    if (found.length) return;
    setBusy(true);
    try {
      await createDraft({
        hostName: hostName.trim(),
        hostPhone: normalizePhone(hostPhone)!,
        goal: goal.trim(),
        participants: complete.map((r) => ({
          name: r.name.trim(),
          phone: normalizePhone(r.phone)!,
          required: r.required,
        })),
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
    setHostPhone(prettyPhone(demo.hostPhone ?? ''));
    setGoal(demo.goal);
    setRows(demo.participants.map((p) => ({ ...p, phone: prettyPhone(p.phone) })));
    setProblems([]);
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

        <div className="host-grid">
          <div>
            <label className="form-label kicker" htmlFor="host">
              Your name
            </label>
            <input
              id="host"
              className="field"
              placeholder="Host"
              value={hostName}
              onChange={(e) => setHostName(e.target.value)}
            />
          </div>
          <div>
            <label className="form-label kicker" htmlFor="host-phone">
              Your phone number
            </label>
            <input
              id="host-phone"
              className="field"
              type="tel"
              placeholder="(415) 555-0100"
              value={hostPhone}
              onChange={(e) => setHostPhone(sanitizePhoneInput(e.target.value))}
              onBlur={() => normalizePhone(hostPhone) && setHostPhone(prettyPhone(hostPhone))}
            />
          </div>
        </div>

        <div className="form-label kicker">Everyone else</div>
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
                placeholder="(415) 555-0101"
                type="tel"
                value={row.phone}
                onChange={(e) => updateRow(i, { phone: sanitizePhoneInput(e.target.value) })}
                onBlur={() => prettify(i)}
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
          <button className="btn-ink" disabled={busy} onClick={() => void submit()}>
            Create Badger →
          </button>
          <button className="link" onClick={() => setRows((prev) => [...prev, { ...EMPTY_ROW }])}>
            Add participant
          </button>
          <button className="link" onClick={loadDemo}>
            Load demo scenario
          </button>
        </div>
        {problems.length > 0 && (
          <ul className="form-problems">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {snap.error && <div className="form-error">{snap.error}</div>}
      </div>
    </div>
  );
}
