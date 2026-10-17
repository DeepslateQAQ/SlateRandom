import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';

const root = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(root, 'resources/icons');
const sourcePath = path.join(assets, 'icon-source.png');
const source = await readFile(sourcePath);
if (source.length < 24 || source.readUInt32BE(0) !== 0x89504e47 || source.toString('ascii', 1, 4) !== 'PNG') {
  throw new Error('resources/icons/icon-source.png must be a PNG image.');
}
const width = source.readUInt32BE(16);
const height = source.readUInt32BE(20);
if (width !== height || width < 256) {
  throw new Error('resources/icons/icon-source.png must be a square image at least 256 px wide.');
}

// Reuse the supplied artwork for every size. Resvg rasterizes the embedded PNG
// without adding a native image dependency to the Windows build.
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
  '<title>SlateRandom — Material Symbols shuffle</title>' +
  `<image href="data:image/png;base64,${source.toString('base64')}" width="${width}" height="${height}"/>` +
  '</svg>';

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map(size => new Resvg(svg, {
  fitTo: { mode: 'width', value: size },
}).render().asPng());
await mkdir(assets, { recursive: true });
await writeFile(path.join(assets, 'icon.png'), images.at(-1));

// ICO can contain PNG images directly; every entry uses the supplied artwork.
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < sizes.length; i++) {
  const entry = 6 + i * 16;
  header[entry] = sizes[i] === 256 ? 0 : sizes[i];
  header[entry + 1] = header[entry];
  header.writeUInt16LE(1, entry + 4);
  header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(images[i].length, entry + 8);
  header.writeUInt32LE(offset, entry + 12);
  offset += images[i].length;
}
await writeFile(path.join(assets, 'icon.ico'), Buffer.concat([header, ...images]));
console.log('SlateRandom icons: supplied shuffle artwork; PNG and 7-size ICO.');
