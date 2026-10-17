import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'qa-output');
const reportPath = path.join(output, 'modern-toolchain-report.json');
const artifact = await readFile(path.join(root, 'dist/index.html'));
const sha256 = createHash('sha256').update(artifact).digest('hex');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tsconfig = JSON.parse(await readFile(path.join(root, 'tsconfig.json'), 'utf8'));
if (tsconfig.compilerOptions?.strict !== true || tsconfig.vueCompilerOptions?.strictTemplates !== true) {
  throw new Error('The toolchain report requires strict TypeScript and strict Vue templates.');
}
const pinnedPnpm = pkg.packageManager.match(/^pnpm@([^+]+)(?:\+.*)?$/)?.[1];
if (!pinnedPnpm) throw new Error('package.json must pin the pnpm package manager.');
const commands = [];

async function run(executable, args, label) {
  commands.push(label);
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '', tooLarge = false;
    const child = spawn(executable, args, { cwd: root, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (stdout.length > 32 * 1024 * 1024) { tooLarge = true; child.kill(); }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0 || tooLarge) {
        console.error(stdout.slice(-12000) + stderr);
        reject(new Error(`${label} failed (exit ${code}${tooLarge ? ', excessive output' : ''}).`));
      } else resolve({ stdout, stderr });
    });
  });
}

async function findPnpm() {
  const candidates = [process.env.PNPM_EXECUTABLE];
  if (process.platform === 'win32') {
    if (process.env.PNPM_HOME) candidates.push(path.join(process.env.PNPM_HOME, 'pnpm.exe'));
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm/node_modules/pnpm/pnpm.exe'));
  }
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const base = directory.replace(/^"|"$/g, '');
    candidates.push(path.join(base, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm'));
    if (process.platform === 'win32') candidates.push(path.join(base, 'node_modules/pnpm/pnpm.exe'));
  }
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error('Cannot locate the pinned pnpm executable. Install pnpm or set PNPM_EXECUTABLE to its absolute path.');
}

async function testFiles(directory, extension, recursive = false) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(extension)) files.push(relative);
    else if (recursive && entry.isDirectory() && entry.name !== 'assets') files.push(...await testFiles(relative, extension, true));
  }
  return files.sort();
}
function summary(stdout) {
  const value = name => {
    const matches = [...stdout.matchAll(new RegExp('^# ' + name + ' (\\d+)\\r?$', 'gm'))];
    if (!matches.length) throw new Error('The Node TAP output is missing its final ' + name + ' count.');
    return Number(matches.at(-1)[1]);
  };
  const result = { tests: value('tests'), passed: value('pass'), failures: value('fail'), cancelled: value('cancelled'), skipped: value('skipped'), todo: value('todo') };
  if (!result.tests || result.failures || result.cancelled || result.tests !== result.passed + result.failures + result.cancelled + result.skipped + result.todo) {
    throw new Error('The TAP run did not complete with a consistent passing test count.');
  }
  return result;
}
const coreNames = { 'chain-cooldown': 'chainCooldown', 'speech-providers': 'speech' };
const groups = [], unitTests = {};
await mkdir(output, { recursive: true });
await rm(reportPath, { force: true });
try {
  const pnpm = await findPnpm();
  const version = (await run(pnpm, ['--version'], 'pnpm --version')).stdout.trim();
  if (version !== pinnedPnpm) throw new Error(`Expected pnpm ${pinnedPnpm}; found ${version}.`);
  console.log('Typecheck: pnpm ' + version + ', strict TypeScript and Vue templates.');
  const check = await run(pnpm, ['check'], 'pnpm check');
  await writeFile(path.join(output, 'toolchain-typecheck.log'), check.stdout + check.stderr);
  try { await access(path.join(root, 'build/windows/SlateRandom.Privileges.exe')); }
  catch {
    const helperBuild = await run(process.execPath, ['scripts/build-windows-helper.mjs', '--arch=x64'], 'node scripts/build-windows-helper.mjs --arch=x64');
    await writeFile(path.join(output, 'toolchain-helper-build.log'), helperBuild.stdout + helperBuild.stderr);
  }

  const core = [...await testFiles('tests/unit/shared', '.test.cjs'), ...await testFiles('tests/unit/renderer/legacy', '.test.cjs')];
  if (!core.length) throw new Error('No canonical core test files were found.');
  const runs = core.map(file => ({ name: coreNames[path.basename(file, '.test.cjs')] || path.basename(file, '.test.cjs'), category: 'core', files: [file], typed: false }));
  const desktopFiles = await testFiles('tests/unit/main', '.test.cjs', true);
  if (!desktopFiles.length) throw new Error('No desktop main-process test files were found.');
  runs.push({ name: 'desktop', category: 'desktop', files: desktopFiles, typed: false });
  for (const category of ['domain', 'platform', 'application', 'desktop']) {
    const files = await testFiles('tests/unit/renderer/' + category, '.test.ts');
    if (!files.length) throw new Error('No TypeScript ' + category + ' tests were found.');
    runs.push({ name: category === 'desktop' ? 'desktopFrontend' : category, category, files, typed: true });
  }
  for (const group of runs) {
    const args = [...(group.typed ? ['--import', 'tsx'] : []), '--test', '--test-reporter=tap', ...group.files];
    const result = await run(process.execPath, args, 'node ' + args.join(' '));
    const log = 'toolchain-tests-' + group.name + '.tap';
    await writeFile(path.join(output, log), result.stdout + result.stderr);
    const counts = summary(result.stdout);
    groups.push({ name: group.name, category: group.category, files: group.files, ...counts, log });
    const totalKey = group.category === 'core' ? 'core' : group.name;
    unitTests[totalKey] = (unitTests[totalKey] || 0) + counts.tests;
    console.log(group.name + ': ' + counts.tests + ' tests passed.');
  }
  unitTests.total = groups.reduce((total, group) => total + group.tests, 0);
  unitTests.failures = groups.reduce((total, group) => total + group.failures, 0);
  unitTests.cancelled = groups.reduce((total, group) => total + group.cancelled, 0);
  unitTests.skipped = groups.reduce((total, group) => total + group.skipped, 0);
  unitTests.todo = groups.reduce((total, group) => total + group.todo, 0);
  const currentArtifact = await readFile(path.join(root, 'dist/index.html'));
  if (!currentArtifact.equals(artifact)) throw new Error('The HTML artifact changed while the toolchain checks were running. Run this script after the final build.');
  const report = { artifactBytes: artifact.length, sha256, completedAt: new Date().toISOString(),
    typecheck: { passed: true, strict: true, strictTemplates: true, packageManager: 'pnpm@' + version },
    unitTests, groups, commands };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  await rm(path.join(output, 'modern-toolchain-failure.json'), { force: true });
  console.log('Toolchain verified: ' + unitTests.total + ' tests, SHA-256 ' + sha256 + '.');
} catch (error) {
  await writeFile(path.join(output, 'modern-toolchain-failure.json'), JSON.stringify({ artifactBytes: artifact.length, sha256, completedAt: new Date().toISOString(), error: error.stack, groups, commands }, null, 2) + '\n');
  throw error;
}
