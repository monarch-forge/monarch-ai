import { render } from 'preact';
import '@fontsource/doto/700.css';
import './index.css';
import { App } from './app.tsx';
import { startStore } from './lib/store.ts';
import { startVoice } from './lib/voice.ts';

// text size is a per-device preference (Settings → You)
try {
  const t = localStorage.getItem('monarch.textSize');
  if (t) document.documentElement.dataset.textSize = t;
} catch {
  /* storage unavailable */
}
startStore();
startVoice();
render(<App />, document.getElementById('app')!);
