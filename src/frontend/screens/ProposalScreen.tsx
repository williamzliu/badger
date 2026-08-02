import { useBadger } from '../store';

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
          <h1 className="plan-time">{plan.time}</h1>
          <div className="plan-venue">
            {plan.theater} · {plan.format} · ${plan.price}
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
    </div>
  );
}
