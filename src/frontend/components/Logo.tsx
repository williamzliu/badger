import logoUrl from '../../assets/badger_logo.svg';

/**
 * The full Badger wordmark (mark + "Badger"). Height is set in CSS via the
 * `.logo` class so it stays consistent wherever the brand appears.
 */
export default function Logo({ className = '' }: { className?: string }) {
  return <img className={`logo ${className}`.trim()} src={logoUrl} alt="Badger" />;
}
