// Dev helper: node scripts/hook.mjs <hookdir> js '<expression>' | shot <file.png> | size <width> <height>
import fs from 'node:fs';
import path from 'node:path';

const [dir, kind, arg, arg2] = process.argv.slice(2);
const id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
const cmd = kind === 'shot' ? { shot: path.resolve(arg) } : kind === 'size' ? { size: [Number(arg), Number(arg2)] } : { js: arg };
fs.writeFileSync(path.join(dir, `cmd-${id}.json`), JSON.stringify(cmd));
const res = path.join(dir, `res-${id}.json`);
const end = Date.now() + 15000;
while (Date.now() < end) {
  if (fs.existsSync(res)) {
    console.log(fs.readFileSync(res, 'utf8'));
    fs.unlinkSync(res);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 100));
}
console.error('timeout');
process.exit(1);
