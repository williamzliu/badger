import { useEffect, useRef } from 'react';
import { useBadger } from '../store';

/** One celebratory burst, hand-rolled — no dependency, no loop. */
function fireConfetti(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => undefined;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.scale(dpr, dpr);

  const colors = ['#f6a821', '#f4f4f8', '#4ade80', '#60a5fa'];
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const particles = Array.from({ length: 130 }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.5;
    const speed = 7 + Math.random() * 9;
    return {
      x: width / 2 + (Math.random() - 0.5) * 120,
      y: height * 0.62,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 4 + Math.random() * 5,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.3,
      life: 1,
    };
  });

  let frame = 0;
  let raf = 0;
  const tick = () => {
    frame += 1;
    ctx.clearRect(0, 0, width, height);
    let alive = false;
    for (const p of particles) {
      p.vy += 0.22;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.spin;
      p.life = Math.max(0, 1 - frame / 150);
      if (p.life <= 0 || p.y > height + 20) continue;
      alive = true;
      ctx.save();
      ctx.globalAlpha = p.life;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    }
    if (alive) raf = requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, width, height);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

export default function CommitScreen() {
  const snap = useBadger();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !canvasRef.current) return;
    return fireConfetti(canvasRef.current);
  }, []);

  const session = snap.session;
  if (!session) return null;
  const plan = snap.selectedCandidate;
  const total = snap.totalCount;

  return (
    <div className="commit">
      <canvas ref={canvasRef} className="confetti-canvas" />
      <div className="commit-headline">
        <b>
          {snap.confirmedCount}/{total}
        </b>{' '}
        committed
      </div>
      {plan && (
        <div className="commit-plan">
          {plan.time} · {plan.theater} · {plan.format}
        </div>
      )}
      <div className="commit-sub">Confirmation texts are on their way.</div>
      <div className="commit-tagline">
        You don't ask the group. You send <b>Badger</b>.
      </div>
    </div>
  );
}
