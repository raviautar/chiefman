// Hides key-like strings before any text reaches the screen.
const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
];
const KEYVAL = /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)(["']?\s*[:=]\s*["']?)([^\s"',;&)]{4,})/gi;
const BEARER = /\b(bearer)(\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const HEX = /\b[0-9a-fA-F]{32,}\b/g;
const B64 = /[A-Za-z0-9+_=-]{40,}/g;

function hide(s, keepLength) {
  return keepLength ? '*'.repeat(s.length) : '••••••••';
}

function mask(text, keepLength = false) {
  if (!text) return text;
  let out = text;
  for (const re of PATTERNS) out = out.replace(re, (m) => hide(m, keepLength));
  const keep = (m, k, sep, v) => (/^(\*+|•+)$/.test(v) ? m : k + sep + hide(v, keepLength));
  out = out.replace(KEYVAL, keep).replace(BEARER, keep);
  // 40 lowercase hex is a git commit, which stays readable.
  out = out.replace(HEX, (m) => (m.length === 40 && m === m.toLowerCase() ? m : hide(m, keepLength)));
  out = out.replace(B64, (m) => (/[0-9]/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? hide(m, keepLength) : m));
  return out;
}

module.exports = { mask };
