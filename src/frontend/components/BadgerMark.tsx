/**
 * The Badger mark — 18×18 pixel art rendered as pure SVG rects, so it is
 * identical in every browser (no font or image dependency). Edit the grid,
 * not the paths. K = ink, W = white, R = accent; '.' = transparent.
 * Keep index.html's favicon in sync when the grid changes.
 */
const ART = [
  '..................',
  '...KK........KK...',
  '..KKKK......KKKK..',
  '..KKKKKKKKKKKKKK..',
  '.KKWKKWWWWWWKKWKK.',
  '.KWWKKWWWWWWKKWWK.',
  'KWWWKKWWWWWWKKWWWK',
  'KWWWKWKWWWWKWKWWWK',
  'KWWWKWKWWWWKWKWWWK',
  'KWWWKKWWWWWWKKWWWK',
  'KWWWWWWWWWWWWWWWWK',
  '.KWWWWWWWWWWWWWWK.',
  '.KWWWWWWRRWWWWWWK.',
  '..KWWWWWRRWWWWWK..',
  '..KWWWWKWWKWWWWK..',
  '...KWWWWWWWWWWK...',
  '....KKKKKKKKKK....',
  '..................',
];

const COLORS: Record<string, string> = { K: '#161511', W: '#fffdf8', R: '#c93400' };

function pathFor(pixel: string): string {
  let d = '';
  ART.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] === pixel) {
        const x0 = x;
        while (x < row.length && row[x] === pixel) x += 1;
        d += `M${x0} ${y}h${x - x0}v1h-${x - x0}z`;
      } else {
        x += 1;
      }
    }
  });
  return d;
}

const PATHS = Object.keys(COLORS).map((pixel) => ({ fill: COLORS[pixel], d: pathFor(pixel) }));

export default function BadgerMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      shapeRendering="crispEdges"
      aria-hidden="true"
      style={{ display: 'block' }}
    >
      {PATHS.map(({ fill, d }) => (
        <path key={fill} fill={fill} d={d} />
      ))}
    </svg>
  );
}
