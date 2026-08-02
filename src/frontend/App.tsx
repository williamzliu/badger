import { useBadger } from './store';
import CreateScreen, { LaunchOverlay } from './screens/CreateScreen';
import LiveScreen from './screens/LiveScreen';
import ProposalScreen from './screens/ProposalScreen';
import CommitScreen from './screens/CommitScreen';
import DemoControl from './screens/DemoControl';

export default function App() {
  const snap = useBadger();

  if (location.pathname.startsWith('/demo-control')) return <DemoControl />;

  let screen: React.ReactNode;
  switch (snap.phase) {
    case 'create':
      screen = <CreateScreen />;
      break;
    case 'proposal':
      screen = <ProposalScreen />;
      break;
    case 'committed':
      screen = <CommitScreen />;
      break;
    default:
      screen = <LiveScreen />;
  }

  return (
    <>
      {screen}
      {snap.launching && <LaunchOverlay count={snap.totalCount} />}
    </>
  );
}
