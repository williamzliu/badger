import type { Participant, ParticipantStatus } from '../../shared/types';
import { useBadger, type FeedItem, type FeedKind } from '../store';

const STATUS_LABEL: Record<ParticipantStatus, { text: string; tone: string; icon: string }> = {
  PENDING: { text: 'Waiting…', tone: 'st-muted', icon: '·' },
  TEXTED: { text: 'Texted', tone: 'st-muted', icon: '✉' },
  CALLING: { text: 'Ringing…', tone: 'st-call', icon: '●' },
  IN_CALL: { text: 'In call', tone: 'st-call', icon: '●' },
  RESPONDED: { text: 'Availability received', tone: 'st-ok', icon: '✓' },
  NEEDS_FOLLOWUP: { text: 'Following up…', tone: 'st-accent', icon: '●' },
  PROPOSED: { text: 'Reviewing the plan…', tone: 'st-accent', icon: '●' },
  CONFIRMED: { text: 'Confirmed', tone: 'st-ok', icon: '✓' },
  DECLINED: { text: 'Declined', tone: 'st-danger', icon: '✕' },
};

const FEED_ICON: Record<FeedKind, string> = {
  info: '·',
  sms: '✉',
  call: '☎',
  conflict: '!',
  success: '✓',
};

function cardClass(p: Participant): string {
  if (p.status === 'CALLING' || p.status === 'IN_CALL') return 'p-card card is-active';
  if (p.status === 'NEEDS_FOLLOWUP') return 'p-card card is-followup';
  if (p.status === 'RESPONDED' || p.status === 'CONFIRMED') return 'p-card card is-done';
  return 'p-card card';
}

function ParticipantCard({ participant }: { participant: Participant }) {
  const status = STATUS_LABEL[participant.status] ?? STATUS_LABEL.PENDING;
  return (
    <div className={cardClass(participant)}>
      <div className="avatar">{participant.name.charAt(0).toUpperCase()}</div>
      <div className="p-info">
        <div className="p-name">{participant.name}</div>
        <div className={`p-status ${status.tone}`}>
          <span className="dot" />
          {status.text}
        </div>
      </div>
    </div>
  );
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function FeedRow({ item }: { item: FeedItem }) {
  return (
    <div className={`feed-item feed-${item.kind}`}>
      <span className="feed-time">{time(item.timestamp)}</span>
      <span className="feed-icon">{FEED_ICON[item.kind]}</span>
      <span className="feed-msg">{item.message}</span>
    </div>
  );
}

export default function LiveScreen() {
  const snap = useBadger();
  const session = snap.session;
  if (!session) return null;

  return (
    <div className="live">
      <div className="live-top">
        <div>
          <span className="wordmark">
            🦡 <b>BADGER</b>
          </span>
          <div className="live-goal">
            {session.goal} · for {session.hostName}
          </div>
        </div>
        <div className="live-stat">
          <b>
            {snap.respondedCount}/{snap.totalCount}
          </b>
          <span>availability received</span>
        </div>
      </div>

      {snap.phase === 'cancelled' && (
        <div className="conflict-banner">✕ A required participant declined — this Badger is off.</div>
      )}
      {snap.conflictActive && (
        <div className="conflict-banner">
          ! One availability conflict detected
          {snap.followUpName ? ` — following up with ${snap.followUpName}` : ''}
        </div>
      )}

      <div className="live-grid">
        <div className="cards-col">
          {session.participants.map((p) => (
            <ParticipantCard key={p.id} participant={p} />
          ))}
        </div>
        <div className="feed card">
          <div className="feed-title">
            <span className="dot" />
            Badger activity
          </div>
          <div className="feed-list">
            {snap.feed.length === 0 ? (
              <div className="feed-empty">Waiting for Badger…</div>
            ) : (
              snap.feed.map((item) => <FeedRow key={item.id} item={item} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
