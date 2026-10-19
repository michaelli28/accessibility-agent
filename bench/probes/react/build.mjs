// SPIKE: bundles src/main.jsx against pinned React installs in the gitignored .deps/ (never the repo's package.json)
// into dist/<react18|react19>-<prod|dev>/, plus a static non-React control page at dist/control/.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPS = join(HERE, '.deps');
const DIST = join(HERE, 'dist');

const PINNED = { react18: '18.3.1', react19: '19.3.0' };
const REACT_INSTALLS = {};
for (const [label, version] of Object.entries(PINNED)) {
  const prefix = join(DEPS, label);
  if (!existsSync(join(prefix, 'node_modules', 'react-dom', 'package.json'))) {
    mkdirSync(prefix, { recursive: true });
    execFileSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', `react@${version}`, `react-dom@${version}`], {
      stdio: 'inherit',
    });
  }
  REACT_INSTALLS[label] = join(prefix, 'node_modules');
}
const MODES = ['prod', 'dev'];

const INDEX_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>react-probe</title></head>' +
  '<body><div id="root"></div><script src="app.js"></script></body></html>\n';

const CONTROL_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>control-probe</title></head><body>
<div id="root">
<div data-probe="ctl-listener" style="cursor:pointer">Listener div</div>
<div data-probe="ctl-inline" onclick="window.__clicks.push('ctl-inline')">Inline onclick div</div>
</div>
<script>
window.__clicks = [];
window.__PROBE__ = { react: null, reactDom: null, nodeEnv: null };
document.querySelector('[data-probe="ctl-listener"]').addEventListener('click', function () { window.__clicks.push('ctl-listener'); });
</script>
</body></html>
`;

rmSync(DIST, { recursive: true, force: true });

for (const [label, nodeModules] of Object.entries(REACT_INSTALLS)) {
  for (const mode of MODES) {
    const prod = mode === 'prod';
    const outDir = join(DIST, `${label}-${mode}`);
    mkdirSync(outDir, { recursive: true });
    const result = await build({
      entryPoints: [join(HERE, 'src', 'main.jsx')],
      bundle: true,
      format: 'iife',
      outfile: join(outDir, 'app.js'),
      nodePaths: [nodeModules],
      define: { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') },
      minify: prod,
      jsx: 'automatic',
      jsxDev: !prod,
      metafile: true,
      logLevel: 'warning',
    });
    writeFileSync(join(outDir, 'index.html'), INDEX_HTML);

    const reactInputs = Object.keys(result.metafile.inputs).filter((p) => /node_modules\/(react|react-dom|scheduler)\//.test(p));
    const absInputs = reactInputs.map((p) => resolve(process.cwd(), p));
    const foreign = absInputs.filter((p) => !p.startsWith(nodeModules));
    const pkgs = [...new Set(reactInputs.map((p) => p.replace(/^.*node_modules\/([^/]+)\/.*$/, '$1')))];
    const firstInput = absInputs[0] ?? '(none)';
    console.log(
      `${label}-${mode}: app.js ${statSync(join(outDir, 'app.js')).size} bytes; react inputs=${reactInputs.length} pkgs=${pkgs.join(',')} foreign=${foreign.length} sample=${firstInput}`,
    );
  }
}

mkdirSync(join(DIST, 'control'), { recursive: true });
writeFileSync(join(DIST, 'control', 'index.html'), CONTROL_HTML);
console.log('control: written');
