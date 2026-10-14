import { cp, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await rm(output, { recursive: true, force: true });

const compiler = spawnSync(
  process.execPath,
  [fileURLToPath(new URL('node_modules/typescript/bin/tsc', root)), '-p', 'tsconfig.build.json'],
  { cwd: fileURLToPath(root), stdio: 'inherit' },
);
if (compiler.error || compiler.status !== 0) {
  await rm(output, { recursive: true, force: true });
  if (compiler.error) console.error(compiler.error.message);
  process.exit(compiler.status ?? 1);
}

// Runtime and evaluation verification hash the original source bytes. Preserve
// those inputs beside emitted JS so an existing verification remains valid.
for (const [directory, extension] of [
  ['src', '.ts'],
  ['eval', '.ts'],
  ['vendor', '.json'],
  ['config', '.json'],
]) {
  await cp(new URL(directory, root), new URL(directory, output), {
    recursive: true,
    filter: async (path) => (await stat(path)).isDirectory() || path.endsWith(extension),
  });
}
console.log('Built dist/: JavaScript, vendor settings, and verification source metadata.');
