const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile('tmux', args, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

async function hasSession(name) {
  try {
    await run(['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

// tmux control mode escapes bytes below 32 and the backslash as \ooo.
function decodeOutput(buf, start) {
  const out = Buffer.allocUnsafe(buf.length - start);
  let j = 0;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0x5c && i + 3 < buf.length && isOct(buf[i + 1]) && isOct(buf[i + 2]) && isOct(buf[i + 3])) {
      out[j++] = (buf[i + 1] - 48) * 64 + (buf[i + 2] - 48) * 8 + (buf[i + 3] - 48);
      i += 3;
    } else {
      out[j++] = c;
    }
  }
  return out.subarray(0, j);
}
const isOct = (c) => c >= 48 && c <= 55;

// One control-mode client on the session. It never resizes anyone's windows.
class Control extends EventEmitter {
  constructor(session) {
    super();
    this.session = session;
    this.proc = null;
    this.pending = [];
    this.block = null;
    this.rest = Buffer.alloc(0);
  }

  start() {
    const p = spawn('tmux', ['-C', 'attach-session', '-f', 'ignore-size', '-t', `=${this.session}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = p;
    p.stdout.on('data', (d) => this.onData(d));
    p.stderr.on('data', (d) => this.emit('log', d.toString()));
    p.on('exit', (code) => {
      this.proc = null;
      for (const q of this.pending) q.reject(new Error('control client closed'));
      this.pending = [];
      this.emit('exit', code);
    });
    p.stdin.on('error', () => {});
  }

  // Closing stdin ends a control client by itself, so no detach command is
  // sent that could reach another client.
  stop() {
    const p = this.proc;
    if (!p) return;
    try {
      p.stdin.end();
    } catch {}
    setTimeout(() => p.kill(), 500);
  }

  get alive() {
    return !!this.proc;
  }

  // Sends one line that may hold several commands ("a ; b"). tmux runs them
  // back to back, so no pane output lands between them. done(err, results)
  // runs in the same tick as the last %end, before any later notification.
  send(line, count, done) {
    if (!this.proc) return done(new Error('not attached'));
    const results = [];
    let failed = null;
    for (let i = 0; i < count; i++) {
      this.pending.push({
        resolve: (t) => {
          results.push(t);
          if (results.length === count) done(failed, results);
        },
        reject: (e) => {
          failed = failed || e;
          results.push(null);
          if (results.length === count) done(failed, results);
        },
      });
    }
    this.proc.stdin.write(line + '\n');
  }

  command(cmd) {
    return new Promise((resolve, reject) => this.send(cmd, 1, (err, r) => (err ? reject(err) : resolve(r[0]))));
  }

  onData(chunk) {
    let buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      this.onLine(buf.subarray(start, nl));
      start = nl + 1;
    }
    this.rest = Buffer.from(buf.subarray(start));
  }

  onLine(line) {
    if (this.block) {
      const s = line.toString('latin1');
      if ((s.startsWith('%end ') || s.startsWith('%error ')) && s.split(' ')[2] === this.block.num) {
        const b = this.block;
        this.block = null;
        if (b.mine) {
          const q = this.pending.shift();
          if (q) {
            const text = Buffer.concat(b.lines.flatMap((l, i) => (i ? [Buffer.from('\n'), l] : [l]))).toString('utf8');
            if (s.startsWith('%error ')) q.reject(new Error(text));
            else q.resolve(text);
          }
        }
        return;
      }
      this.block.lines.push(Buffer.from(line));
      return;
    }
    if (line[0] !== 0x25) return; // '%'
    const head = line.subarray(0, Math.min(line.length, 80)).toString('latin1');
    if (head.startsWith('%output ')) {
      const sp = head.indexOf(' ', 8);
      const pane = head.slice(8, sp);
      this.emit('output', pane, decodeOutput(line, sp + 1));
      return;
    }
    if (head.startsWith('%begin ')) {
      const parts = head.split(' ');
      this.block = { num: parts[2], mine: parts[3] === '1', lines: [] };
      return;
    }
    const s = line.toString('utf8');
    const parts = s.split(' ');
    switch (parts[0]) {
      case '%window-add':
      case '%window-close':
      case '%window-renamed':
      case '%layout-change':
      case '%session-window-changed':
      case '%window-pane-changed':
        this.emit('windows', parts[0], parts[1]);
        break;
      case '%exit':
        this.emit('closing', parts.slice(1).join(' '));
        break;
      default:
        break;
    }
  }
}

module.exports = { run, hasSession, Control };
