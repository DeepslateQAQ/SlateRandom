import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'qa-output');
const scripts = ['tests/e2e/qa.mjs', 'tests/e2e/qa-extra.mjs', 'tests/e2e/qa-ui.mjs', 'tests/e2e/qa-friend.mjs', 'tests/e2e/qa-render-styles.mjs', 'tests/e2e/qa-speech.mjs', 'tests/e2e/qa-settings-layout.mjs', 'tests/e2e/qa-dev-smoke.mjs', 'tests/e2e/qa-import.mjs', 'tests/integration/qa-desktop.mjs', 'tests/integration/qa-packaged.mjs'];
const start = process.argv.includes('--from') ? scripts.slice(scripts.indexOf(process.argv[process.argv.indexOf('--from') + 1])) : scripts;
const skipped = process.argv.includes('--skip') ? process.argv[process.argv.indexOf('--skip') + 1]?.split(',') ?? [] : [];
if (skipped.some(script => !scripts.includes(script))) throw Error('Unknown QA skip script.');
const selected = start.filter(script => !skipped.includes(script));
if (!selected.length || process.argv.includes('--from') && !scripts.includes(process.argv[process.argv.indexOf('--from') + 1])) throw Error('Unknown QA starting script.');
await mkdir(output, { recursive: true });
for (const script of selected) {
  console.log('START ' + script);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script)], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', milestones = 0;
    const timer = setTimeout(() => { child.kill(); reject(Error(script + ' exceeded its eight-minute limit.')); }, 480000);
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      const passed = (stdout.match(/^PASS /gm) || []).length;
      if (Math.floor(passed / 25) > milestones) { milestones = Math.floor(passed / 25); console.log(script + ': ' + passed + ' checks passed'); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  await writeFile(path.join(output, 'suite-' + path.basename(script, path.extname(script)) + '.log'), result.stdout + '\n' + result.stderr);
  if (result.code !== 0) { console.error(result.stdout.slice(-3500)); console.error(result.stderr.slice(-4500)); throw Error(script + ' failed with exit ' + result.code); }
  console.log('PASS ' + script + ' complete');
}
console.log('All selected browser and desktop suites passed.');
