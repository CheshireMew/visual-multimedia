import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(root, process.env.REACT_MEDIA_OUT_DIR || 'dist');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json'));
const filesUnder = (directory) => {
  const files = [];
  const visit = (current) => fs.readdirSync(current, {withFileTypes: true}).forEach((entry) => {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) visit(absolute);
    else files.push(path.relative(root, absolute).replaceAll('\\', '/'));
  });
  visit(path.join(root, directory));
  return files.sort();
};
const sourceFiles = [
  'index.html',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  ...filesUnder('public'),
  ...filesUnder('scripts'),
  ...filesUnder('src'),
].sort();
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sourceSha256 = hash(Buffer.concat(sourceFiles.map((name) => fs.readFileSync(path.join(root, name)))));
const info = {
  protocol: 'editable-media-react-build',
  version: 1,
  editable_media_version: 6,
  dependencies: packageJson.dependencies,
  lock_sha256: hash(lockBytes),
  source_sha256: sourceSha256,
  sourcemaps: true,
};
fs.writeFileSync(path.join(output, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);

const manifestPath = path.join(output, 'editable-media.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const generatedAssets = [];
const collectGeneratedAssets = (current) => fs.readdirSync(current, {withFileTypes: true}).forEach((entry) => {
  const absolute = path.join(current, entry.name);
  if (entry.isDirectory()) collectGeneratedAssets(absolute);
  else generatedAssets.push(path.relative(output, absolute).replaceAll('\\', '/'));
});
collectGeneratedAssets(path.join(output, 'assets'));
manifest.resources = [
  ...manifest.resources.filter((resource) => !resource.startsWith('assets/')),
  ...generatedAssets.sort(),
];
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
