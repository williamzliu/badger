interface MastheadProps {
  kicker?: string;
  live?: string;
}

export default function Masthead({ kicker, live }: MastheadProps) {
  return (
    <header className="masthead">
      <span className="name serif">Badger</span>
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
