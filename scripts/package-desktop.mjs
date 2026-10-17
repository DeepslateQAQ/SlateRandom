import { packager } from '@electron/packager';
import { mkdtemp, mkdir, readFile, writeFile, cp, access, rm, stat, realpath } from 'fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = path.join(root, 'release');
const requestedArch = process.argv.find(value => value.startsWith('--arch='))?.slice(7) || 'x64';
if (!['x64', 'arm64'].includes(requestedArch)) throw new Error('Unsupported Windows architecture: ' + requestedArch);
const expectedOutput = path.resolve(release, `SlateRandom-win32-${requestedArch}`);
const helper = path.join(root, 'build/windows', `SlateRandom.Privileges${requestedArch === 'x64' ? '' : '-arm64'}.exe`);
const skipBuild = process.argv.includes('--skip-build');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
if (process.platform !== 'win32') throw new Error('The desktop package targets Windows; run this command on Windows.');
if (!skipBuild) {
  await run(process.execPath, [path.join(root, 'scripts/build-single.mjs')]);
  await run(process.execPath, [path.join(root, 'scripts/build-windows-helper.mjs'), `--arch=${requestedArch}`]);
  await run(process.execPath, [path.join(root, 'scripts/build-icons.mjs')]);
}
for (const file of ['dist/index.html', 'src/main/main.cjs', 'src/preload/preload.cjs', 'resources/icons/icon.ico']) {
  await access(path.join(root, file));
}
await access(helper);
await mkdir(release, { recursive: true });
const staging = await mkdtemp(path.join(root, '.desktop-stage-'));
const appDir = path.join(staging, 'app');
const helperDir = path.join(staging, 'windows');
await mkdir(appDir);
await mkdir(helperDir);
try {
  const appPackage = {
    name: pkg.name, productName: pkg.productName, version: pkg.version,
    description: pkg.description, main: pkg.main, type: 'commonjs',
    license: pkg.license, author: pkg.author, dependencies: { 'node-edge-tts': pkg.dependencies['node-edge-tts'] }
  };
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify(appPackage, null, 2) + '\n');
  await cp(path.join(root, 'dist'), path.join(appDir, 'dist'), { recursive: true });
  await cp(path.join(root, 'src/main'), path.join(appDir, 'src/main'), {
    recursive: true, filter: async source => (await stat(source)).isDirectory() || (source.endsWith('.cjs') && !source.endsWith('.test.cjs')),
  });
  for (const file of ['src/preload/preload.cjs', 'src/shared/domain/engine.js']) {
    await mkdir(path.dirname(path.join(appDir, file)), { recursive: true });
    await cp(path.join(root, file), path.join(appDir, file));
  }
  const runtimePackages = new Set();
  const visitPackage = async name => {
    if (runtimePackages.has(name)) return;
    runtimePackages.add(name);
    const source = await realpath(path.join(root, 'node_modules', name));
    const metadata = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    // node-edge-tts uses yargs only in its standalone CLI, not its runtime API.
    for (const dependency of Object.keys(metadata.dependencies || {})) {
      if (name === 'node-edge-tts' && dependency === 'yargs') continue;
      await visitPackage(dependency);
    }
    await mkdir(path.join(appDir, 'node_modules'), { recursive: true });
    await cp(source, path.join(appDir, 'node_modules', name), { recursive: true });
  };
  await visitPackage('node-edge-tts');
  await cp(path.join(root, 'resources/icons'), path.join(appDir, 'resources/icons'), { recursive: true });
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await cp(path.join(root, file), path.join(appDir, file));
  }
  // The package ships a plain-text README; the repository may only keep the
  // Markdown source, so fall back to it instead of requiring a duplicate.
  const readme = await access(path.join(root, 'README.txt')).then(() => 'README.txt', () => 'README.md');
  await cp(path.join(root, readme), path.join(appDir, 'README.txt'));
  await mkdir(path.join(appDir, 'licenses'));
  for (const file of ['MaterialSymbols-LICENSE.txt', 'MaterialSymbols-NOTICE.txt', 'SheetJS-LICENSE.txt']) {
    await cp(path.join(root, 'resources', file.startsWith('SheetJS') ? 'vendor' : 'fonts', file), path.join(appDir, 'licenses', file));
  }
  await cp(helper, path.join(helperDir, 'SlateRandom.Privileges.exe'));
  const output = await packager({
    dir: appDir, out: release, name: 'SlateRandom', executableName: 'SlateRandom',
    platform: 'win32', arch: requestedArch, electronVersion: pkg.devDependencies.electron,
    icon: path.join(root, 'resources/icons/icon.ico'), asar: true, prune: false,
    tmpdir: false, overwrite: true, extraResource: [helperDir],
    appVersion: pkg.version, appCopyright: 'Copyright © 2026 DeepslateQAQ',
    win32metadata: {
      CompanyName: 'DeepslateQAQ', FileDescription: 'SlateRandom 岩选',
      ProductName: 'SlateRandom 岩选', InternalName: 'SlateRandom', OriginalFilename: 'SlateRandom.exe',
    },
  });
  if (output.length !== 1) throw new Error('Expected one Windows output.');
  const appOutput = path.resolve(output[0]);
  if (appOutput !== expectedOutput) throw new Error('Unexpected packager output location.');
  const zip = path.join(release, `SlateRandom-${pkg.version}-windows-${requestedArch}.zip`);
  await rm(zip, { force: true });
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const zipScript = 'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${literal(appOutput)}, ${literal(zip)}, [System.IO.Compression.CompressionLevel]::Optimal, $true)`;
  await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', zipScript], { windowsHide: true });
  const html = await readFile(path.join(root, 'dist/index.html'));
  const executable = await readFile(path.join(appOutput, 'SlateRandom.exe'));
  const zipInfo = await stat(zip);
  const manifest = {
    product: pkg.productName, author: pkg.author, version: pkg.version, electron: pkg.devDependencies.electron,
    platform: 'win32', arch: requestedArch, app: path.relative(root, appOutput).replaceAll('\\', '/'),
    portableZip: path.relative(root, zip).replaceAll('\\', '/'), zipBytes: zipInfo.size,
    htmlSHA256: createHash('sha256').update(html).digest('hex'),
    executableSHA256: createHash('sha256').update(executable).digest('hex'),
    appId: 'io.slaterandom.app', unsigned: true,
  };
  await writeFile(path.join(release, requestedArch === 'x64' ? 'desktop-build.json' : `desktop-build-${requestedArch}.json`), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Desktop: ${appOutput}\nPortable ZIP: ${zip}\nThe application ships without native Node add-ons; Electron and the icon renderer use prebuilt binaries.`);
} finally {
  const checked = path.resolve(staging);
  if (path.dirname(checked) !== path.resolve(root) || !path.basename(checked).startsWith('.desktop-stage-')) {
    throw new Error('Refusing to remove an unexpected staging directory.');
  }
  await rm(checked, { recursive: true, force: true });
}
