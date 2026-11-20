import { copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { rcedit } from 'rcedit';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(root, 'sea-config.json');
const blob = path.join(root, 'sea-prep.blob');
const executable = path.join(root, 'dist', 'agent-hub.exe');
await writeFile(configFile, JSON.stringify({ main: path.join(root, 'dist', 'agent-hub.cjs'), output: blob, disableExperimentalSEAWarning: true }));
try {
  await execFileAsync(process.execPath, ['--experimental-sea-config', configFile], { cwd: root });
  await copyFile(process.execPath, executable);
  const { version } = JSON.parse(await readFile(path.join(root, '../package.json'), 'utf8'));
  const license = await readFile(path.join(root, '../LICENSE'), 'utf8');
  const copyright = license.split(/\r?\n/).find((line) => line.startsWith('Copyright '));
  if (!copyright) throw new Error('LICENSE copyright notice missing');
  await rcedit(executable, {
    'version-string': {
      ProductName: 'Agent Hub',
      FileDescription: 'Agent Hub daemon',
      CompanyName: 'Agent Hub contributors',
      LegalCopyright: copyright,
      OriginalFilename: 'agent-hub.exe',
      InternalName: 'agent-hub',
    },
    'file-version': version,
    'product-version': version,
  });
  await execFileAsync(process.execPath, [
    path.resolve(root, '../node_modules/postject/dist/cli.js'),
    executable,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ], { cwd: root });
  console.log(`Created ${executable}`);
} finally {
  await rm(configFile, { force: true });
  await rm(blob, { force: true });
}
