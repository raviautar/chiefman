const fs = require('fs');
const path = require('path');

// Dollars per million tokens: input, output, cache read; then the context
// window. Read on 2026-11-20 from the claude-api skill (its table is cached
// 2026-11-03). Cache writes cost 1.25x input for 5 minutes, 2x for 1 hour.
// Haiku 5.5 costs more on prompts over 100K tokens; that is not counted.
const PRICES = {
  'claude-fable-5-2': [8, 40, 0.2, 1e6],
  'claude-mythos-5-2': [8, 40, 0.2, 1e6],
  'claude-fable-5-1': [10, 50, 0.25, 1e6],
  'claude-mythos-5-1': [10, 50, 0.25, 1e6],
  'claude-fable-5': [10, 50, 1, 1e6],
  'claude-opus-5-5': [4, 20, 0.2, 1e6],
  'claude-opus-5': [5, 25, 0.5, 1e6],
  'claude-opus-4-8': [5, 25, 0.5, 1e6],
  'claude-opus-4-7': [5, 25, 0.5, 1e6],
  'claude-opus-4-6': [5, 25, 0.5, 1e6],
  'claude-sonnet-5-5': [2, 10, 0.1, 1e6],
  'claude-sonnet-5': [2, 10, 0.2, 1e6],
  'claude-sonnet-4-6': [3, 15, 0.3, 1e6],
  'claude-haiku-5-5': [0.1, 0.5, 0.01, 1e6],
  'claude-haiku-4-5': [1, 5, 0.1, 2e5],
};
const KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);
const CHUNK = 16 * 1024 * 1024;

function price(model) {
  const k = KEYS.find((key) => typeof model === 'string' && model.startsWith(key));
  return k ? PRICES[k] : null;
}

function cost(model, u) {
  const p = price(model);
  if (!p || !u) return 0;
  const [inp, out, read] = p;
  const cc = u.cache_creation || {};
  const w5 = cc.ephemeral_5m_input_tokens;
  const w1 = cc.ephemeral_1h_input_tokens;
  const writes =
    w5 != null || w1 != null ? (w5 || 0) * inp * 1.25 + (w1 || 0) * inp * 2 : (u.cache_creation_input_tokens || 0) * inp * 1.25;
  return ((u.input_tokens || 0) * inp + (u.output_tokens || 0) * out + (u.cache_read_input_tokens || 0) * read + writes) / 1e6;
}

const MODEL_NAMES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable', mythos: 'Mythos' };

function modelName(id) {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(id || '');
  if (!m) return null;
  return `${MODEL_NAMES[m[1]]} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
}

function idFromName(name) {
  const m = /^(Opus|Sonnet|Haiku|Fable|Mythos) (\d+)(?:\.(\d+))?/i.exec(name || '');
  return m ? `claude-${m[1].toLowerCase()}-${m[2]}${m[3] ? '-' + m[3] : ''}` : null;
}

// Follows one session log and its subagent logs for what they cost, which
// model answered last, how full the context is, and model or effort switches.
class Usage {
  constructor(file) {
    this.file = file;
    this.files = new Map();
    this.msgs = new Map();
    this.last = null;
    this.seq = 0;
    this.modelSet = null;
    this.effortSet = null;
    this.busy = false;
  }

  subDir() {
    return path.join(path.dirname(this.file), path.basename(this.file, '.jsonl'), 'subagents');
  }

  async poll() {
    if (this.busy) return false;
    this.busy = true;
    const before = this.seq;
    try {
      const list = [this.file];
      try {
        for (const f of fs.readdirSync(this.subDir())) if (f.endsWith('.jsonl')) list.push(path.join(this.subDir(), f));
      } catch {}
      for (const f of list) await this.read(f);
    } finally {
      this.busy = false;
    }
    return this.seq !== before;
  }

  async read(file) {
    let st = this.files.get(file);
    if (!st) {
      st = { offset: 0, rest: '', main: file === this.file };
      this.files.set(file, st);
    }
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return;
    }
    if (size < st.offset) {
      st.offset = 0;
      st.rest = '';
    }
    if (size === st.offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      while (st.offset < size) {
        const len = Math.min(CHUNK, size - st.offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.offset);
        st.offset += len;
        const lines = (st.rest + buf.toString('utf8')).split('\n');
        st.rest = lines.pop();
        for (const line of lines) this.line(line, st.main);
        if (st.offset < size) await new Promise((r) => setImmediate(r));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  line(line, main) {
    // The big request logs start with their type; message lines do not.
    if (line.startsWith('{"type":"') && !line.startsWith('{"type":"assistant"') && !line.startsWith('{"type":"system"')) return;
    const assistant = line.includes('"usage"') && line.includes('"type":"assistant"');
    // Claude logs a command's output as a system line or, in newer versions,
    // as a user line holding <local-command-stdout>.
    const local = main && (line.includes('"local_command"') || line.includes('local-command-stdout'));
    if (!assistant && !local) return;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    const userOut = d.type === 'user' && d.message && typeof d.message.content === 'string' && d.message.content.includes('<local-command-stdout>');
    if ((d.type === 'system' && d.subtype === 'local_command') || userOut) {
      const c = userOut ? d.message.content : typeof d.content === 'string' ? d.content : '';
      const m = /Set model to `?([A-Za-z]+ [\d.]+)/.exec(c);
      if (m && idFromName(m[1])) {
        this.modelSet = { id: idFromName(m[1]), seq: ++this.seq, at: Date.parse(d.timestamp) || 0 };
      }
      const e = /Set effort level to (low|medium|high|xhigh|max)\b/.exec(c);
      if (e) this.effortSet = { effort: e[1], seq: ++this.seq, at: Date.parse(d.timestamp) || 0 };
      return;
    }
    const msg = d.type === 'assistant' && d.message;
    if (!msg || !msg.usage || !msg.id || !price(msg.model)) return;
    this.msgs.set(msg.id, { model: msg.model, u: msg.usage });
    this.seq++;
    if (main && !d.isSidechain) this.last = { model: msg.model, u: msg.usage, seq: this.seq, at: Date.parse(d.timestamp) || 0 };
  }

  get total() {
    let t = 0;
    for (const { model, u } of this.msgs.values()) t += cost(model, u);
    return t;
  }

  get model() {
    if (this.modelSet && (!this.last || this.modelSet.seq > this.last.seq)) return this.modelSet.id;
    return this.last ? this.last.model : null;
  }

  // Tokens the last answer read, and the model's window.
  get tokens() {
    if (!this.last) return null;
    const u = this.last.u;
    const p = price(this.last.model);
    const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    return p ? { used, max: p[3] } : null;
  }

  get context() {
    const t = this.tokens;
    return t ? Math.min(1, t.used / t.max) : null;
  }
}

module.exports = { Usage, modelName, price, cost, PRICES };
