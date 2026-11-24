import { useEffect, useState, type MouseEvent } from 'react';
import { api, Box } from './api';

// Remote Control in the box's header: a phone, filled when on, outline when
// off. A click turns it off or on; a right-click copies its link.
export function RemoteButton({ box, onError }: { box: Box; onError: (text: string) => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 4000);
    return () => clearTimeout(t);
  }, [copied]);
  useEffect(() => setCopied(null), [box.paneId]);

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
    if (!box.paneId || !on) return;
    const r = await api().remote(box.paneId, 'link');
    if (!r.url) return onError(r.reason || 'No link yet.');
    api().copy(r.url);
    setCopied(r.url);
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
        <span className="copied" role="status">
          Link copied ·{' '}
          <button
            className="text-btn"
            onClick={() => {
              api().openUrl(copied);
              setCopied(null);
            }}
          >
            Open
          </button>
        </span>
      )}
    </span>
  );
}
