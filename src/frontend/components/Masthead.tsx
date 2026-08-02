import Logo from './Logo';

interface MastheadProps {
  meta?: string;
  live?: string;
}

export default function Masthead({ meta, live }: MastheadProps) {
  return (
    <header className="masthead">
      <Logo />
      {live ? (
        <span className="livepill">
          <span className="livedot" />
          {live}
        </span>
      ) : meta ? (
        <span className="mast-meta">{meta}</span>
      ) : null}
    </header>
  );
}
