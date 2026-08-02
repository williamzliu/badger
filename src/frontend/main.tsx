import { createRoot } from 'react-dom/client';
import './theme.css';
import './screens.css';
import App from './App';
import { initAppChannel } from './channel';
import { badger } from './store';
import * as api from './api';

const isControlWindow = location.pathname.startsWith('/demo-control');
if (!isControlWindow) {
  initAppChannel();
  try {
    const health = await api.health();
    const operatorMode = localStorage.getItem('badger.mode.operator');
    // A healthy live backend is the safe default. Mock mode is only honored
    // when the operator explicitly selected it from /demo-control.
    if (health.live && operatorMode !== 'mock') {
      localStorage.setItem('badger.mode', 'live');
      badger.setMode('live');
    }
  } catch {
    // Leave the stored mode alone when the backend is unavailable. Live mode
    // will surface the connection error instead of silently playing a fake.
  }
  if (badger.getSnapshot().mode === 'live') await api.resume();
}

createRoot(document.getElementById('root')!).render(<App />);
