import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const production = process.argv.includes('production');

/**
 * `?raw` loader: lets us inline pdf.worker.min.js as a string and turn it into
 * a blob URL at runtime. This is what lets the plugin run on Obsidian mobile,
 * where loading an external script (CDN) is blocked by the CSP.
 */
const rawPlugin = {
  name: 'raw',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, async (args) => {
      const resolved = await build.resolve(args.path.replace(/\?raw$/, ''), {
        resolveDir: args.resolveDir,
        kind: 'import-statement',
      });
      return { path: resolved.path, namespace: 'raw' };
    });
    build.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => {
      const contents = await fs.promises.readFile(args.path, 'utf8');
      return { contents: JSON.stringify(contents), loader: 'js' };
    });
  },
};

async function run() {
  await esbuild.build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    external: ['obsidian', 'electron'],
    format: 'cjs',
    target: 'es2018',
    outfile: 'main.js',
    sourcemap: production ? false : 'inline',
    plugins: [rawPlugin],
    logLevel: 'info',
    treeShaking: true,
  });
  console.log('build ok → main.js');
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
