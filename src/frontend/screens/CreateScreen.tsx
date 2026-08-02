import { useState, type KeyboardEvent } from 'react';
import {
  IconDice5,
  IconPlus,
  IconMinus,
  IconArrowRight,
  IconArrowLeft,
  IconPencil,
  IconCheck,
} from '@tabler/icons-react';
import { useBadger } from '../store';
import { createDraft, demoDraft, discardDraft, sendBadger } from '../actions';
import { normalizePhone, prettyPhone, sanitizePhoneInput } from '../phone';
import Logo from '../components/Logo';
import BadgerMark from '../components/BadgerMark';
import RotatingStatus from '../components/RotatingStatus';
import RotatingWordMorph from '../components/RotatingWordMorph';

interface Row {
  id: string;
  name: string;
  phone: string;
  required: boolean;
  editing: boolean;
}

const newRow = (editing = true): Row => ({
  id: crypto.randomUUID(),
  name: '',
  phone: '',
  required: true,
  editing,
});

const MIN_OTHERS = 1;

export function LaunchOverlay({ count }: { count: number }) {
  const phrases = [
    `Harassing ${count} calendars…`,
    'Bothering your friends on your behalf…',
    'Calling people who thought they were safe…',
    'Weaponizing the follow-up…',
    'Turning “we should hang” into administrative action…',
  ];
  return (
    <div className="overlay">
      <span className="overlay-badger">
        <BadgerMark size={64} />
      </span>
      <RotatingStatus className="overlay-text" phrases={phrases} />
    </div>
  );
}


interface InviteeRowProps {
  name: string;
  phone: string;
  required: boolean;
  editing: boolean;
  isHost?: boolean;
  canRemove?: boolean;
  label: string;
  onPatch: (patch: Partial<Pick<Row, 'name' | 'phone' | 'required'>>) => void;
  onEdit: () => void;
  onDone: () => void;
  onRemove?: () => void;
}

function InviteeRow({
  name,
  phone,
  required,
  editing,
  isHost = false,
  canRemove = false,
  label,
  onPatch,
  onEdit,
  onDone,
  onRemove,
}: InviteeRowProps) {
  const attendance = required ? 'Attendance required' : 'Not required to attend';
  const saveOnEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onDone();
    }
  };
  return (
    <div
      className={`p-row${isHost ? ' is-host' : ''}${editing ? '' : ' is-clickable'}`}
      onClick={editing ? undefined : onEdit}
    >
      {editing ? (
        <>
          <input
            className="field"
            placeholder={isHost ? 'Your name' : 'Name'}
            value={name}
            onChange={(e) => onPatch({ name: e.target.value })}
            onKeyDown={saveOnEnter}
            aria-label={`${label} name`}
            autoFocus={!isHost && !name}
          />
          <input
            className="field"
            type="tel"
            placeholder={isHost ? 'Your phone number' : 'Phone number'}
            value={phone}
            onChange={(e) => onPatch({ phone: sanitizePhoneInput(e.target.value) })}
            onKeyDown={saveOnEnter}
            aria-label={`${label} phone`}
          />
          {isHost ? (
            <span className="p-tag">Host</span>
          ) : (
            <label className="check">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => onPatch({ required: e.target.checked })}
              />
              <span className="check-box">{required && <IconCheck size={13} stroke={3} />}</span>
              Required attendance
            </label>
          )}
        </>
      ) : (
        <>
          <span className="p-cell">{name || '—'}</span>
          <span className="p-cell">{phone ? prettyPhone(phone) : '—'}</span>
          {isHost ? (
            <span className="p-tag">Host</span>
          ) : (
            <span className="p-cell is-muted">{attendance}</span>
          )}
        </>
      )}

      <button
        className="icon-btn"
        type="button"
        onClick={editing ? onDone : onEdit}
        aria-label={editing ? `Done editing ${label}` : `Edit ${label}`}
      >
        {editing ? <IconCheck size={18} stroke={2} /> : <IconPencil size={18} stroke={2} />}
      </button>

      {isHost ? (
        <span />
      ) : (
        <button
          className="icon-btn is-danger"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove?.();
          }}
          disabled={!canRemove}
          aria-label={`Remove ${label}`}
        >
          <IconMinus size={18} stroke={2} />
        </button>
      )}
    </div>
  );
}

export default function CreateScreen() {
  const snap = useBadger();
  const [hostName, setHostName] = useState('');
  const [hostPhone, setHostPhone] = useState('');
  const [hostEditing, setHostEditing] = useState(true);
  const [goal, setGoal] = useState('');
  const [rows, setRows] = useState<Row[]>([newRow()]);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  // A draft session exists → launch stage.
  if (snap.session) {
    const others = snap.session.participants.slice(1);
    return (
      <div className="plan">
        <button className="plan-back" type="button" onClick={discardDraft} aria-label="Back">
          <IconArrowLeft size={26} stroke={2} />
        </button>
        <div className="plan-body">
          <div className="plan-eyebrow">The Plan</div>
          <h1 className="display plan-headline">{snap.session.goal}</h1>
          {others.length > 0 && (
            <div className="plan-with">
              <span>With</span>
              {others.map((p) => (
                <span className="name-pill" key={p.id}>
                  {p.name}
                </span>
              ))}
            </div>
          )}
          <button className="btn btn-primary btn-lg" onClick={() => void sendBadger()}>
            Send Badger
            <IconArrowRight size={18} stroke={2.2} />
          </button>
          {snap.error && <div className="form-error">{snap.error}</div>}
        </div>
      </div>
    );
  }

  const updateRow = (id: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const finishRow = (id: string) =>
    setRows((prev) =>
      prev.map((row) =>
        row.id === id
          ? { ...row, editing: false, phone: normalizePhone(row.phone) ? prettyPhone(row.phone) : row.phone }
          : row,
      ),
    );

  const finishHost = () => {
    if (normalizePhone(hostPhone)) setHostPhone(prettyPhone(hostPhone));
    setHostEditing(false);
  };

  const validate = (): { problems: string[]; complete: Row[] } => {
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
      found.push('Badger needs at least one other person — it coordinates people, not solo trips.');
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

  const randomize = () => {
    const demo = demoDraft();
    setHostName(demo.hostName);
    setHostPhone(prettyPhone(demo.hostPhone ?? ''));
    setHostEditing(false);
    setGoal(demo.goal);
    setRows(
      demo.participants.map((p) => ({
        id: crypto.randomUUID(),
        name: p.name,
        phone: prettyPhone(p.phone),
        required: p.required,
        editing: false,
      })),
    );
    setProblems([]);
  };

  return (
    <div className="stage is-center">
      {snap.mode === 'mock' && <div className="mode-banner">Rehearsal</div>}
      <div className="create">
        <Logo />
        <h1 className="display-hero create-title">
          What&rsquo;s the <RotatingWordMorph words={['move', 'plan', 'idea', 'vibe', 'hang']} />?
        </h1>

        <div className="card">
          <div className="card-sec">
            <span className="sec-label">Idea</span>
            <div className="idea-row">
              <input
                className="field-plain"
                placeholder="Go see a movie…"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                autoFocus
              />
              <button className="btn btn-primary" type="button" onClick={randomize}>
                <IconDice5 size={18} stroke={2} />
                Randomize
              </button>
            </div>
          </div>

          <div className="card-sec">
            <span className="sec-label">Invitees</span>
            <div className="p-list">
              <InviteeRow
                isHost
                label="host"
                name={hostName}
                phone={hostPhone}
                required
                editing={hostEditing}
                onPatch={(patch) => {
                  if (patch.name !== undefined) setHostName(patch.name);
                  if (patch.phone !== undefined) setHostPhone(patch.phone);
                }}
                onEdit={() => setHostEditing(true)}
                onDone={finishHost}
              />

              {rows.map((row, i) => (
                <InviteeRow
                  key={row.id}
                  label={`participant ${i + 1}`}
                  name={row.name}
                  phone={row.phone}
                  required={row.required}
                  editing={row.editing}
                  canRemove={rows.length > 1}
                  onPatch={(patch) => updateRow(row.id, patch)}
                  onEdit={() => updateRow(row.id, { editing: true })}
                  onDone={() => finishRow(row.id)}
                  onRemove={() => setRows((prev) => prev.filter((r) => r.id !== row.id))}
                />
              ))}
            </div>

            <button
              className="add-row"
              type="button"
              onClick={() => setRows((prev) => [...prev, newRow()])}
            >
              <IconPlus size={18} stroke={2} />
              Add a participant
            </button>
          </div>
        </div>

        <div className="create-actions">
          <button className="btn btn-primary btn-lg" disabled={busy} onClick={() => void submit()}>
            Create Badger
            <IconArrowRight size={18} stroke={2.2} />
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
