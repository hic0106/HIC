// Catches browser modules that use a helper from ko.js / util.js without importing it (breaks the whole UI).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('public/js');
const exportsOf = (f) => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/export (?:const|function|class) (\w+)/g)].map((m) => m[1]);
const shared = { 'ko.js': exportsOf('ko.js'), 'util.js': exportsOf('util.js') };

test('every public/js module imports the ko.js / util.js names it uses', () => {
  const problems = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/`(?:\\.|[^`])*`/gs, (m) => m.replace(/'[^']*'|"[^"]*"/g, '')).replace(/'(?:\\.|[^'])*'|"(?:\\.|[^"])*"/g, "''");
    for (const [mod, names] of Object.entries(shared)) {
      if (f === mod) continue;
      const imp = src.match(new RegExp(`import \\{([^}]*)\\} from '\\./${mod.replace('.', '\\.')}'`));
      const imported = new Set((imp?.[1] || '').split(',').map((x) => x.trim()));
      for (const n of names) {
        if (imported.has(n)) continue;
        if (new RegExp(`(?:const|let|function|class)\\s+${n}\\b`).test(code)) continue; // own definition
        if (new RegExp(`(?<![\\w.$])${n}(?:\\[|\\(|\\.|\\s*;|\\s*\\))`).test(code)) problems.push(`${f}: ${n} (from ${mod})`);
      }
    }
  }
  assert.deepEqual(problems, []);
});
