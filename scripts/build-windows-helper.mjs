import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src/native/windows/SlateRandom.Privileges.cs');
const manifest = path.join(root, 'src/native/windows/SlateRandom.Privileges.manifest');
const requestedArch = process.argv.find(value => value.startsWith('--arch='))?.slice(7) || 'x64';
if (!['x64', 'arm64'].includes(requestedArch)) throw new Error('Unsupported Windows helper architecture: ' + requestedArch);
const helperArch = requestedArch === 'arm64' ? 'anycpu' : 'x64';
const output = path.join(root, `build/windows/SlateRandom.Privileges${requestedArch === 'x64' ? '' : '-arm64'}.exe`);

if (process.platform !== 'win32') throw new Error('Build the Windows helper on Windows with the .NET Framework C# compiler.');
const windowsDirectory = process.env.SystemRoot || 'C:\\Windows';
const compiler = path.join(windowsDirectory, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
await access(compiler).catch(() => { throw new Error('The .NET Framework 4.x C# compiler is missing. Install .NET Framework build tools.'); });
await mkdir(path.dirname(output), { recursive: true });
const args = ['/nologo', '/target:exe', `/platform:${helperArch}`, '/optimize+', '/deterministic+', '/debug-', '/utf8output', '/reference:System.Web.Extensions.dll', `/win32manifest:${manifest}`, `/out:${output}`, source];
// Framework's inbox compiler may predate /deterministic; retry that flag only.
let result;
try { result = await run(compiler, args, { windowsHide: true, maxBuffer: 1024 * 1024 }); }
catch (error) {
  if (!String(error.stdout || error.stderr).includes('deterministic')) throw error;
  result = await run(compiler, args.filter(value => value !== '/deterministic+'), { windowsHide: true, maxBuffer: 1024 * 1024 });
}
if (result.stdout.trim()) process.stdout.write(result.stdout);
const bytes = await readFile(output);
if (requestedArch === 'arm64') {
  if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('ARM64 helper is not a PE executable.');
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 0x18 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) throw new Error('ARM64 helper has an invalid PE header.');
  const optional = peOffset + 24;
  const magic = bytes.readUInt16LE(optional);
  const dataDirectory = optional + (magic === 0x20b ? 112 : 96);
  const cliRva = bytes.readUInt32LE(dataDirectory + 14 * 8);
  if (!cliRva) throw new Error('ARM64 helper has no CLR header.');
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const sectionTable = optional + bytes.readUInt16LE(peOffset + 20);
  let cliOffset;
  for (let index = 0; index < sectionCount; index++) {
    const section = sectionTable + index * 40;
    const virtualSize = bytes.readUInt32LE(section + 8);
    const virtualAddress = bytes.readUInt32LE(section + 12);
    if (cliRva >= virtualAddress && cliRva < virtualAddress + virtualSize) {
      cliOffset = bytes.readUInt32LE(section + 20) + cliRva - virtualAddress;
      break;
    }
  }
  if (!cliOffset || cliOffset + 20 > bytes.length) throw new Error('ARM64 helper CLR header is invalid.');
  const flags = bytes.readUInt32LE(cliOffset + 16);
  if (!(flags & 1) || (flags & 0x20000)) throw new Error('ARM64 helper is not a runnable AnyCPU IL assembly.');
  const manifestText = await readFile(manifest, 'utf8');
  if (!manifestText.includes('processorArchitecture="*"')) throw new Error('ARM64 helper manifest is not architecture-neutral.');
}
const proof = { runtime: '.NET Framework 4.x', architecture: requestedArch, helperPlatform: helperArch, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sourceSha256: createHash('sha256').update(await readFile(source)).digest('hex') };
await writeFile(path.join(root, 'build/windows', `build-info-${requestedArch}.json`), JSON.stringify(proof, null, 2) + '\n', 'utf8');
if (requestedArch === 'x64') await writeFile(path.join(root, 'build/windows/build-info.json'), JSON.stringify(proof, null, 2) + '\n', 'utf8');
process.stdout.write(`Windows helper built: ${bytes.length} bytes, SHA256 ${proof.sha256}\n`);
