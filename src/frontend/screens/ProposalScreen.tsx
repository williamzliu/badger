import { useBadger } from '../store';
import { restartSession } from '../actions';
import { formatCandidateLabel, formatCandidateTime } from '../../shared/display';

export default function ProposalScreen() {
  const snap = useBadger();
  const session = snap.session;
  if (!session) return null;
  const plan = snap.selectedCandidate;

  return (
    <div className="proposal">
      <span className="kicker">Badger's plan</span>
      {plan ? (
        <>
          <h1 className="plan-time">{formatCandidateTime(plan.time)}</h1>
          <div className="plan-venue">
            {[plan.theater, plan.format !== 'Activity' ? formatCandidateLabel(plan.format) : null, plan.price > 0 ? `$${plan.price}` : null]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </>
      ) : (
        <h1 className="plan-time">{snap.feed[0]?.message ?? 'Finalizing…'}</h1>
      )}

      <div className="confirm-table">
        {session.participants.map((p, i) => {
          const confirmed = p.status === 'CONFIRMED';
          const declined = p.status === 'DECLINED';
          return (
            <div className="confirm-row" key={p.id} style={{ animationDelay: `${i * 90}ms` }}>
              <span className="roster-name">{p.name}</span>
              {confirmed ? (
                <span className="roster-status smallcaps is-done">Confirmed</span>
              ) : declined ? (
                <span className="roster-status smallcaps is-declined">Declined</span>
              ) : (
                <span className="roster-status smallcaps is-hot">
                  <span className="livedot" />
                  Confirming
                </span>
              )}
            </div>
          );
        })}
      </div>
      <button className="btn-line proposal-reset" type="button" onClick={restartSession}>
        Start over
      </button>
    </div>
  );
}
