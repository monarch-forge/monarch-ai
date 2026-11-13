import { render } from 'preact';
import './index.css';
import { App } from './app.tsx';
import { startStore } from './lib/store.ts';

startStore();
render(<App />, document.getElementById('app')!);
