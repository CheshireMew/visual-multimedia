import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'react-media-repro-'));
const directories = [path.join(temporaryRoot, 'first'), path.join(temporaryRoot, 'second')];
const digest = (directory) => {
  const files = [];
  const walk = (current) => fs.readdirSync(current, {withFileTypes: true}).forEach((entry) => {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else files.push(path.relative(directory, absolute).replaceAll('\\', '/'));
  });
  walk(directory);
  const hash = crypto.createHash('sha256');
  files.sort().forEach((file) => {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(directory, file)));
  });
  return hash.digest('hex');
};

try {
  for (const output of directories) {
    const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: root,
      env: {...process.env, REACT_MEDIA_OUT_DIR: output},
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const metadata = spawnSync(process.execPath, [path.join(root, 'scripts/write-build-info.mjs')], {
      cwd: root,
      env: {...process.env, REACT_MEDIA_OUT_DIR: output},
      encoding: 'utf8',
    });
    if (metadata.status !== 0) throw new Error(metadata.stderr || metadata.stdout);
  }
  const first = digest(directories[0]);
  const second = digest(directories[1]);
  if (first !== second) throw new Error(`React build is not reproducible: ${first} != ${second}`);
  console.log(JSON.stringify({ok: true, sha256: first}, null, 2));
} finally {
  fs.rmSync(temporaryRoot, {recursive: true, force: true});
}
