import { useBadger } from '../store';

export default function ProposalScreen() {
  const snap = useBadger();
  const session = snap.session;
  if (!session) return null;
  const plan = snap.selectedCandidate;

  return (
    <div className="proposal">
      <span className="eyebrow">Badger's plan</span>
      <div className="plan-card card">
        {plan ? (
          <>
            <div className="plan-time">{plan.time}</div>
            <div className="plan-venue">
              {plan.theater} · {plan.format}
            </div>
            <div className="plan-meta">
              {plan.location} · ${plan.price} per ticket
            </div>
          </>
        ) : (
          <div className="plan-time">{snap.feed[0]?.message ?? 'Finalizing…'}</div>
        )}
      </div>

      <div className="confirm-list">
        {session.participants.map((p, i) => {
          const confirmed = p.status === 'CONFIRMED';
          const declined = p.status === 'DECLINED';
          return (
            <div className="confirm-row card" key={p.id} style={{ animationDelay: `${i * 90}ms` }}>
              <span className="p-name">{p.name}</span>
              {confirmed ? (
                <span className="pill pill-ok">✓ Confirmed</span>
              ) : declined ? (
                <span className="pill pill-danger">✕ Declined</span>
              ) : (
                <span className="pill pill-accent">Confirming…</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
