import BadgerMark from './BadgerMark';

interface MastheadProps {
  kicker?: string;
  live?: string;
}

export default function Masthead({ kicker, live }: MastheadProps) {
  return (
    <header className="masthead">
      <span className="mast-brand">
        <BadgerMark size={30} />
        <span className="name serif">Badger</span>
      </span>
      {kicker && <span className="kicker">{kicker}</span>}
      {live ? (
        <span className="livepill">
          <span className="livedot" />
          {live}
        </span>
      ) : (
        <span />
      )}
    </header>
  );
}
