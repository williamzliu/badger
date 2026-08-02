import { useEffect, useState } from 'react';

export default function RotatingStatus({
  phrases,
  className = '',
  intervalMs = 1_250,
}: {
  phrases: readonly string[];
  className?: string;
  intervalMs?: number;
}) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    if (phrases.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % phrases.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [phrases.length, intervalMs]);

  return (
    <span className={className} aria-live="polite">
      <span className="status-phrase" key={index}>{phrases[index] ?? ''}</span>
    </span>
  );
}
