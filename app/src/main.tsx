import { createRoot } from 'react-dom/client';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/eb-garamond/500.css';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
