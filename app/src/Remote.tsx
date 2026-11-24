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

// Remote Control in the box's header: a phone, filled when on, outline when
// off. A click turns it off or on; a right-click copies its link, as Cmd+K
// does. copied: the link just copied, shown under the icon with Open.
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
          ? 'Remote Control on · click turns off · right-click copies link'
          : 'Remote Control off · click turns on';

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
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" fill={filled ? 'currentColor' : 'none'} />
          <path d="M11.5 17h1" stroke={filled ? 'var(--white)' : 'currentColor'} />
          <path d="M19 8.5a4.5 4.5 0 0 1 0 7 M5 8.5a4.5 4.5 0 0 0 0 7" />
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
