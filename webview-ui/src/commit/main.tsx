import { createRoot } from 'react-dom/client';
import '../lib/base.css';
import './commit.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');
createRoot(container).render(<App />);
