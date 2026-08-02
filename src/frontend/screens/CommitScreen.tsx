import { useBadger } from '../store';
import { discardDraft } from '../actions';
import { formatCandidateLabel, formatCandidateTime } from '../../shared/display';

export default function CommitScreen() {
  const snap = useBadger();
  const session = snap.session;
  if (!session) return null;
  const plan = snap.selectedCandidate;
  // The backend commits on required participants only — count the same way,
  // so an optional straggler can't make the finale read "3/4 committed."
  const required = session.participants.filter((p) => p.required);
  const confirmed = required.filter((p) => p.status === 'CONFIRMED').length;

  return (
    <div className="stage is-center">
      <h1 className="display commit-headline">
        {confirmed}/{required.length} <span className="commit-word">committed.</span>
      </h1>
      {plan && (
        <div className="commit-plan">
          {[formatCandidateTime(plan.time), plan.theater, plan.format !== 'Activity' ? formatCandidateLabel(plan.format) : null]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      <div className="commit-sub">Confirmation texts are on their way</div>
      <button className="btn btn-ghost commit-home" type="button" onClick={discardDraft}>
        Start another Badger
      </button>
      <div className="commit-tagline">
        You don't ask the group. You send <b>Badger</b>.
      </div>
    </div>
  );
}
