import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource/instrument-serif';
import '@fontsource/instrument-serif/400-italic.css';
import './theme.css';
import './screens.css';
import App from './App';
import { initAppChannel } from './channel';
import { badger } from './store';
import * as api from './api';

const isControlWindow = location.pathname.startsWith('/demo-control');
if (!isControlWindow) {
  initAppChannel();
  if (badger.getSnapshot().mode === 'live') void api.resume();
}

createRoot(document.getElementById('root')!).render(<App />);
