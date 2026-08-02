import { useBadger } from '../store';

export default function CommitScreen() {
  const snap = useBadger();
  const session = snap.session;
  if (!session) return null;
  const plan = snap.selectedCandidate;

  return (
    <div className="commit">
      <h1 className="commit-headline">
        {snap.confirmedCount}/{snap.totalCount} <span className="commit-word">committed.</span>
      </h1>
      {plan && (
        <div className="commit-plan">
          {plan.time} · {plan.theater} · {plan.format}
        </div>
      )}
      <div className="commit-sub smallcaps">Confirmation texts are on their way</div>
      <div className="commit-tagline">
        You don't ask the group. You send <b>Badger</b>.
      </div>
    </div>
  );
}
