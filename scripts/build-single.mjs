import { build } from 'vite';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildDir = path.join(root, '.vite-build');
const read = name => readFile(path.join(root, name), 'utf8');
const safeScript = source => source.replace(/<\/script/gi, '<\\/script');
const safeStyle = source => source.replace(/<\/style/gi, '<\\/style');
const textBlock = (id, source) => '<script type="text/plain" id="' + id + '">' + safeScript(source) + '</script>';

// Vite compiles the actual Vue entry and its dependency graph once. The
// assembler only embeds the resulting IIFE/CSS and project/vendor licenses.
await build({ configFile: path.join(root, 'vite.config.mts'), mode: 'production' });
const emitted = await readdir(buildDir);
const scripts = emitted.filter(name => /\.(?:js|mjs|cjs)$/.test(name));
const styles = emitted.filter(name => name.endsWith('.css'));
if (scripts.length !== 1 || scripts[0] !== 'rollcall.js') throw new Error('单文件导出要求 Vite 只生成一个经典 IIFE 脚本。');
if (styles.length !== 1) throw new Error('单文件导出要求 Vite 将所有样式合并为一个 CSS 文件。');
const [template, script, css, sheetjs, sheetLicense, iconCss, iconLicense, iconNotice, dependencyLicenses, packageJson, iconFont, projectLicense] = await Promise.all([
  read('index.html'), read('.vite-build/rollcall.js'), read('.vite-build/' + styles[0]),
  read('resources/vendor/xlsx.full.min.js'), read('resources/vendor/SheetJS-LICENSE.txt'), read('src/renderer/styles/icons.css'),
  read('resources/fonts/MaterialSymbols-LICENSE.txt'), read('resources/fonts/MaterialSymbols-NOTICE.txt'),
  read('.vite-build/dependency-licenses.json'), read('package.json'), readFile(path.join(root, 'resources/fonts/MaterialSymbolsOutlined-Subset.woff2')), read('LICENSE')
]);
if (/\bimport\.meta\b|\bimport\s*\(/.test(script)) throw new Error('导出脚本不能依赖模块环境或异步加载 chunk。');
const embeddedIconCss = iconCss.replace('../../../resources/fonts/MaterialSymbolsOutlined-Subset.woff2', 'data:font/woff2;base64,' + iconFont.toString('base64'));
const finalCss = /@font-face\s*\{[^}]*Material Symbols Outlined/i.test(css) ? css : embeddedIconCss + '\n' + css;
for (const match of finalCss.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) {
  const url = match[2];
  if (!url.startsWith('data:') && !url.startsWith('#')) throw new Error('导出样式仍引用外部资源：' + url);
}
const pkg = JSON.parse(packageJson);
const metadata = { appVersion: pkg.version, framework: 'Vue 3', language: 'TypeScript', bundler: 'Vite', format: 'classic IIFE', packageManager: pkg.packageManager, vue: pkg.dependencies.vue, vite: pkg.devDependencies.vite, typescript: pkg.devDependencies.typescript, projectLicense: pkg.license };
const vendors = textBlock('projectLicense', projectLicense) + textBlock('sheetjsLicense', sheetLicense) + textBlock('materialSymbolsLicense', iconLicense) + textBlock('materialSymbolsNotice', iconNotice) + textBlock('dependencyLicenses', dependencyLicenses) + textBlock('buildMetadata', JSON.stringify(metadata)) + '<script>' + safeScript(sheetjs) + '</script>';
const styleMarker = '<!-- INLINE_STYLES -->', vendorMarker = '<script src="/resources/vendor/xlsx.full.min.js"></script>', appMarker = '<script type="module" src="/src/renderer/main.ts"></script>';
if (![styleMarker, vendorMarker, appMarker].every(marker => template.includes(marker))) throw new Error('开发入口缺少单文件导出标记。');
const html = template.replace(styleMarker, () => '<style>' + safeStyle(finalCss) + '</style>').replace(vendorMarker, () => vendors).replace(appMarker, () => '<script>' + safeScript(script) + '</script>');
if (/<script\b[^>]*\bsrc\s*=|<script\b[^>]*\btype\s*=\s*['"]module['"]|<link\b[^>]*\b(?:stylesheet|modulepreload)\b/i.test(html)) throw new Error('导出 HTML 仍包含外部脚本、模块入口或外部样式表。');
await mkdir(path.join(root, 'dist'), { recursive: true });
await writeFile(path.join(root, 'dist/index.html'), html, 'utf8');
const hash = createHash('sha256').update(html).digest('hex');
console.log('已生成 dist/index.html (' + Buffer.byteLength(html) + ' bytes, SHA-256 ' + hash + ')，Vue + TypeScript + Vite 编译，双击即可离线打开。');
