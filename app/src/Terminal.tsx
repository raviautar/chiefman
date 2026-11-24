import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { api } from './api';

// Replies a terminal sends back to a program's queries. tmux already answered
// them for the real terminal, so they must never be typed into the box.
const REPLY = /^\x1b(\[\??[\d;]*[cnRtx]|\[>[\d;]*c|\][^\x07\x1b]*(\x07|\x1b\\)|P[\s\S]*\x1b\\|\[[IO])$/;

export function TerminalView({ paneId }: { paneId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Its colours are the stylesheet's, named at its top.
    const css = getComputedStyle(document.documentElement);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const term = new Terminal({
      fontFamily: "'SF Mono', Menlo, monospace",
      fontSize: 12.5,
      lineHeight: 1.15,
      scrollback: 3000,
      cursorBlink: false,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: {
        background: color('--term-bg'),
        foreground: color('--term-ink'),
        cursor: color('--term-ink'),
        cursorAccent: color('--term-bg'),
        selectionBackground: color('--term-pick'),
      },
      linkHandler: { activate: (_e, uri) => /^https:/.test(uri) && api().openUrl(uri) },
    });
    term.open(host.current!);
    let cols = 120;
    let intent = 0;
    const fit = () => {
      const w = (wrap.current?.clientWidth ?? 800) - 24;
      const size = Math.max(8, Math.min(12.5, Math.floor((w / (cols * 0.602)) * 10) / 10));
      if (term.options.fontSize !== size) term.options.fontSize = size;
    };
    const markIntent = () => (intent = Date.now());
    host.current!.addEventListener('keydown', markIntent, true);
    host.current!.addEventListener('paste', markIntent, true);
    term.onData((d) => {
      if (REPLY.test(d) && Date.now() - intent > 300) return;
      api().termInput(paneId, d);
    });
    const off = api().onEvent((ev) => {
      if (ev.type === 'term-reset' && ev.paneId === paneId) {
        cols = ev.cols;
        term.reset();
        term.resize(ev.cols, ev.rows);
        fit();
        term.write(ev.data);
      } else if (ev.type === 'term' && ev.paneId === paneId) term.write(ev.data);
    });
    const ro = new ResizeObserver(fit);
    ro.observe(wrap.current!);
    api().term(paneId);
    term.focus();
    return () => {
      off();
      ro.disconnect();
      api().term(null);
      term.dispose();
    };
  }, [paneId]);

  return (
    <div className="term-wrap" ref={wrap}>
      <div ref={host} />
    </div>
  );
}
