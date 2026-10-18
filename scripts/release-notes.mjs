#!/usr/bin/env node
/**
 * Compose the GitHub release body in the ClassIsland style.
 *
 * The prose lives in `.github/releases/<version>.md` (hand-written highlight and
 * sections). Without that file the body is generated from the conventional
 * commits since the previous tag. Either way the download/checksum table is
 * appended from the artifacts that were actually built for this tag.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const flag = name => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const tag = flag('--tag') ?? process.env.GITHUB_REF_NAME ?? '';
const version = tag.replace(/^v/, '');
if (!version) throw new Error('release-notes: a tag such as v1.1.0 is required.');
const assetsDirectory = path.resolve(root, flag('--assets') ?? process.env.ASSETS_DIR ?? 'release-assets');
const output = path.resolve(root, flag('--out') ?? process.env.NOTES_OUT ?? 'release-notes.md');
const repository = flag('--repo') ?? process.env.GITHUB_REPOSITORY ?? 'DeepslateQAQ/SlateRandom';

const SECTIONS = [
  { heading: '## 🚀 新增功能与优化', types: ['feat', 'perf', 'refactor', 'style'] },
  { heading: '## 🐛 Bug 修复', types: ['fix', 'revert'] }
];
const NOTES = /^(\w+)(?:\(([^)]*)\))?!?:\s*(?::[\w-]+:)?\s*(.*)$/;
const GITMOJI = /^:[\w-]+:\s*/;

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function previousTag() {
  const explicit = flag('--previous') ?? process.env.PREVIOUS_TAG;
  if (explicit === 'none') return null;
  if (explicit) return explicit;
  try { return git(['describe', '--tags', '--abbrev=0', tag + '^']) || null; }
  catch { return null; }
}

function commitBullets() {
  const previous = previousTag();
  const range = previous ? previous + '..' + tag : tag;
  let log = '';
  try { log = git(['log', '--no-merges', '--format=%s', range]); }
  catch { log = ''; }
  const grouped = new Map(SECTIONS.map(section => [section.heading, []]));
  const other = [];
  for (const subject of log.split('\n').map(line => line.trim()).filter(Boolean)) {
    const match = NOTES.exec(subject);
    if (!match) { other.push(subject.replace(GITMOJI, '')); continue; }
    const [, type, scope, rest] = match;
    const summary = rest.replace(GITMOJI, '').trim();
    const line = '- ' + (scope ? '【' + scope + '】' : '') + summary;
    const section = SECTIONS.find(item => item.types.includes(type));
    if (section) grouped.get(section.heading).push(line);
    else if (['chore', 'docs', 'test', 'build', 'ci'].includes(type)) continue;
    else other.push(summary);
  }
  const blocks = [];
  for (const section of SECTIONS) {
    const lines = grouped.get(section.heading);
    if (lines.length) blocks.push(section.heading + '\n\n' + lines.join('\n'));
  }
  if (other.length) blocks.push('## 🧹 其他改动\n\n' + other.map(line => '- ' + line).join('\n'));
  return blocks.join('\n\n');
}

async function highlight() {
  try { return (await readFile(path.join(root, '.github/releases/' + version + '.md'), 'utf8')).trim(); }
  catch { return ''; }
}

/** Major.minor codenames come from Minecraft's rock blocks; see codenames.json. */
async function codename() {
  const minor = version.split('.').slice(0, 2).join('.');
  let table = {};
  try { table = JSON.parse(await readFile(path.join(root, '.github/releases/codenames.json'), 'utf8')); }
  catch { table = {}; }
  const entry = table[minor];
  if (!entry?.zh) { console.warn('release-notes: no codename for ' + minor + ' in .github/releases/codenames.json'); return ''; }
  return minor + ' - ' + entry.zh + (entry.en ? '（' + entry.en + '）' : '');
}

async function checksums() {
  let files = [];
  try { files = (await readdir(assetsDirectory)).filter(name => !name.startsWith('.')).sort(); }
  catch { return ''; }
  if (!files.length) return '';
  const rows = [];
  for (const name of files) {
    const bytes = await readFile(path.join(assetsDirectory, name));
    const digest = createHash('sha256').update(bytes).digest('hex').toUpperCase();
    const link = 'https://github.com/' + repository + '/releases/download/' + encodeURIComponent(tag) + '/' + encodeURIComponent(name);
    rows.push('| [' + name + '](' + link + ') | ' + digest + ' |');
  }
  return [
    '---',
    '',
    '## 校验和与下载链接',
    '',
    '> [!important]',
    '> 下载后请核对文件 SHA256。桌面版解压后请整个文件夹一起使用，`data/` 目录随程序移动。',
    '',
    '| 文件名 | SHA256 |',
    '| --- | --- |',
    ...rows
  ].join('\n');
}

const body = [
  ['> [!important]', '> 升级前建议先在「数据」里导出全部备份；桌面版请解压后整个文件夹一起使用。'].join('\n'),
  ['SlateRandom 岩选 ' + version, await codename()].filter(Boolean).join('\n'),
  await highlight() || commitBullets(),
  await checksums()
].filter(section => section !== '').join('\n\n');

await writeFile(output, body + '\n');
console.log('release-notes: wrote ' + path.relative(root, output) + ' (' + body.length + ' chars)');
