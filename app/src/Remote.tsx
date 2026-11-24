import { type MouseEvent } from 'react';
import { api, Box } from './api';

// Copies the box's Remote Control link: the link, or null with the reason said.
export async function copyLink(box: Box, onError: (text: string) => void) {
  if (!box.paneId || !box.remote) return null;
  const r = await api().remote(box.paneId, 'link');
  if (!r.url) {
    onError(r.reason || 'No link yet.');
    return null;
  }
  api().copy(r.url);
  return r.url;
}

// Remote Control at the top right of the conversation: a phone. On is the
// usual state, so it shows only while the pointer is near; off shows at
// once, crossed out. A click turns it off or on; a right-click copies its
// link, as Cmd+K does. copied: the link just copied, shown under the icon
// with Open.
export function RemoteButton({
  box,
  copied,
  onCopied,
  onError,
}: {
  box: Box;
  copied: string | null;
  onCopied: (url: string | null) => void;
  onError: (text: string) => void;
}) {
  const on = box.remote;
  // His click shows at once; the box does it once it is idle.
  const going = box.remoteAsk && (box.remoteAsk === 'on') !== on ? box.remoteAsk : null;
  const filled = going ? going === 'on' : on;
  const tip =
    going === 'on'
      ? 'Turning Remote Control on…'
      : going === 'off'
        ? 'Turning Remote Control off…'
        : on
          ? 'Remote Control is on · click turns it off'
          : 'Remote Control is off · click turns it on';

  async function toggle() {
    if (!box.paneId) return;
    const r = await api().remote(box.paneId, filled ? 'off' : 'on');
    if (!r.ok) onError(r.reason || 'Not sent.');
  }

  async function copy(e: MouseEvent) {
    e.preventDefault();
    const url = await copyLink(box, onError);
    if (url) onCopied(url);
  }

  return (
    <span className="keep remote-wrap">
      <button
        className={'icon-btn tip remote' + (filled ? ' on' : '') + (going ? ' going' : '')}
        onClick={toggle}
        onContextMenu={copy}
        aria-label="Remote Control"
        aria-pressed={filled}
        data-tip={tip}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="5" y="2.5" width="10" height="19" rx="2.6" />
          <path d="M9 18.3h2" />
          {filled ? <path d="M18.2 8.6a4.6 4.6 0 0 1 0 6.8 M20.9 6.2a8.2 8.2 0 0 1 0 11.6" /> : <path d="M3 3l18 18" />}
        </svg>
      </button>
      {copied && (
        <span className="copied" role="status" key={copied}>
          Link copied ·{' '}
          <button
            className="text-btn"
            onClick={() => {
              api().openUrl(copied);
              onCopied(null);
            }}
          >
            Open
          </button>
        </span>
      )}
    </span>
  );
}
