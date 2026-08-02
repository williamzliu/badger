import { useEffect, useState } from 'react';
import { TextMorph } from 'torph/react';

/** Word rotator built on torph's TextMorph: shared letters glide to their new
 * positions while the rest crossfade, so words of different widths morph
 * smoothly instead of snapping. */
export default function RotatingWordMorph({
  words,
  className = '',
  intervalMs = 2_000,
}: {
  words: readonly string[];
  className?: string;
  intervalMs?: number;
}) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    if (words.length < 2) return;
    const timer = window.setInterval(() => {
      setIndex((i) => (i + 1) % words.length);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [words.length, intervalMs]);

  return (
    <span className={className}>
      <TextMorph>{words[index] ?? ''}</TextMorph>
    </span>
  );
}
