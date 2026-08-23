/**
 * Dialogs app (P11-T7): one bundle hosting every P11–P13 dialog. The host
 * writes `{dialog}` into the initial state and `dialogHost` serves the params
 * over `dialog/init`; this entry only routes to the right component.
 */
import { createRoot } from 'react-dom/client';
import '../lib/base.css';
import './dialogs.css';
import { getInitialState } from '../lib/vscodeApi';
import { Push } from './Push';
import { ShelveChanges } from './ShelveChanges';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

const init = getInitialState<{ dialog?: string }>();
const dialog = init?.dialog ?? 'shelve';

function pick(): JSX.Element {
  switch (dialog) {
    case 'shelve':
      return <ShelveChanges />;
    case 'push':
      return <Push />;
    default:
      return <div className="gt-dialog-unknown">Unknown dialog: {dialog}</div>;
  }
}

createRoot(container).render(pick());
