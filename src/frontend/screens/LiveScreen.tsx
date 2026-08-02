import type { Participant, ParticipantStatus } from '../../shared/types';
import { useBadger, type BadgerSnapshot, type FeedItem } from '../store';
import { restartSession } from '../actions';
import RotatingStatus from '../components/RotatingStatus';
import Masthead from '../components/Masthead';

const STATUS_TEXT: Record<ParticipantStatus, string> = {
  PENDING: 'Waiting',
  TEXTED: 'Texted',
  // Per the voice contract: don't claim "ringing" — Cartesia's lifecycle
  // starts at call_started, so CALLING only means the call was requested.
  CALLING: 'Calling',
  IN_CALL: 'On the phone',
  RESPONDED: 'Responded',
  NEEDS_FOLLOWUP: 'Following up',
  PROPOSED: 'Reviewing plan',
  CONFIRMED: 'Confirmed',
  DECLINED: 'Declined',
};

const ACTIVE: ParticipantStatus[] = ['CALLING', 'IN_CALL', 'NEEDS_FOLLOWUP'];
const DONE: ParticipantStatus[] = ['RESPONDED', 'CONFIRMED'];

function statusClass(status: ParticipantStatus): string {
  if (status === 'NEEDS_FOLLOWUP') return 'roster-status smallcaps is-hot';
  if (status === 'DECLINED') return 'roster-status smallcaps is-declined';
  if (DONE.includes(status)) return 'roster-status smallcaps is-done';
  return 'roster-status smallcaps';
}

function RosterRow({ participant }: { participant: Participant }) {
  return (
    <tr>
      <td className="roster-name">{participant.name}</td>
      <td className={statusClass(participant.status)}>
        {ACTIVE.includes(participant.status) && <span className="livedot" />}
        {STATUS_TEXT[participant.status] ?? participant.status}
      </td>
    </tr>
  );
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

function spell(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

/** The narrative headline — the screen tells the story of this moment. */
function narrative(snap: BadgerSnapshot): { headline: string; sub: string } {
  const session = snap.session;
  const n = spell(snap.totalCount);
  if (snap.phase === 'cancelled') {
    return { headline: 'This plan is off.', sub: 'A required participant declined.' };
  }
  if (snap.conflictActive) {
    return {
      headline: `One conflict stands between ${n} people and a plan.`,
      sub: snap.followUpName
        ? `Badger is asking ${snap.followUpName} about flexibility.`
        : 'Badger is resolving it.',
    };
  }
  switch (session?.status) {
    case 'CONTACTING':
      return { headline: `Badger is reaching ${n} people.`, sub: 'Texts first. Calls follow.' };
    case 'MATCHING':
      return {
        headline: 'Cross-checking every option.',
        sub: 'Hard constraints are non-negotiable.',
      };
    default:
      return {
        headline: 'Badger is on the phones.',
        sub: `${snap.respondedCount} of ${snap.totalCount} availabilities in — nobody had to chase anyone.`,
      };
  }
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function FeedRow({ item, lead }: { item: FeedItem; lead: boolean }) {
  const kindClass = item.kind === 'conflict' ? ' k-conflict' : item.kind === 'success' ? ' k-success' : '';
  return (
    <div className={`feed-item${lead ? ' is-lead' : ''}${kindClass}`}>
      <span className="feed-time">{time(item.timestamp)}</span>
      <span className="feed-msg">{item.message}</span>
    </div>
  );
}

export default function LiveScreen() {
  const snap = useBadger();
  const session = snap.session;
  if (!session) return null;
  const story = narrative(snap);

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <Masthead
        kicker={`${session.goal} · for ${session.hostName}`}
        live={`Live ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
      />
      <div className="live-head">
        <h1 className="live-headline">{story.headline}</h1>
        <div className="live-sub">{story.sub}</div>
        <button className="btn-line live-reset" type="button" onClick={restartSession}>
          Start over
        </button>
      </div>
      <div className="live-grid" style={{ flex: 1 }}>
        <div className="live-left">
          <div className="stat">
            <span className="stat-n">
              {snap.respondedCount}
              <span>/{snap.totalCount}</span>
            </span>
            <span className="stat-cap">
              availability received{snap.followUpName ? ', one follow-up out' : ''}
            </span>
          </div>
          <table className="roster">
            <tbody>
              {session.participants.map((p) => (
                <RosterRow key={p.id} participant={p} />
              ))}
            </tbody>
          </table>
        </div>
        <div className="live-right">
          <section className="sail-trace" aria-live="polite">
            <div className="sail-trace-head smallcaps">
              <span className="sail-mark">S</span>
              Sail reasoning
              <span className="livedot" />
            </div>
            {snap.sailThoughts.length ? (
              <div className="sail-thoughts">
                {snap.sailThoughts.map((thought, index) => (
                  <div className={`sail-thought${index === 0 ? ' is-current' : ''}`} key={thought.id}>
                    {thought.message}
                  </div>
                ))}
              </div>
            ) : (
              <RotatingStatus
                className="sail-thought is-current"
                intervalMs={1_600}
                phrases={[
                  'Cross-referencing everyone’s excuses…',
                  'Interrogating “I’m free whenever”…',
                  'Looking for a time nobody can complain about…',
                  'Deciding who seems easiest to bother…',
                  'Preparing a diplomatic inconvenience…',
                ]}
              />
            )}
          </section>
          <div className="feed-list">
            {snap.feed.length === 0 ? (
              <RotatingStatus
                className="feed-empty"
                phrases={[
                  'Badger is bothering people now…',
                  'Making “we should hang” legally binding…',
                  'Turning friendship into a scheduling problem…',
                ]}
              />
            ) : (
              snap.feed.map((item, i) => <FeedRow key={item.id} item={item} lead={i === 0} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
