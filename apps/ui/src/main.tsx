import { render } from 'preact';
import './index.css';
import { App } from './app.tsx';
import { startStore } from './lib/store.ts';
import { startVoice } from './lib/voice.ts';

startStore();
startVoice();
render(<App />, document.getElementById('app')!);
