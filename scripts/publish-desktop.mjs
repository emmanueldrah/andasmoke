import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

const feedBase = (process.env.ANDAPOS_UPDATE_URL || 'https://andasmoke.vercel.app/updates/win').replace(/\/+$/, '');
const releasesRepo = (process.env.ANDAPOS_RELEASES_REPO || 'emmanueldrah/andasmoke-pos-releases').trim();
const token = (process.env.ANDAPOS_GITHUB_TOKEN || '').trim();
const binaryBase = (process.env.ANDAPOS_BINARY_BASE_URL || '').replace(/\/+$/, '');
const skipBuild = process.env.ANDAPOS_SKIP_BUILD === '1';

const manifestDir = join(root, 'public', 'updates', 'win');
const manifestPath = join(manifestDir, 'latest.yml');

function run(command, args) {
  console.log(`\n$ ${[command, ...args].join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
}

async function github(pathname, { method = 'GET', body, contentType } = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'anda-smoke-hub-publish',
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body,
  });
  if (response.status === 404) return { status: 404, data: null };
  if (!response.ok) throw new Error(`GitHub ${method} ${pathname} failed (${response.status}): ${await response.text()}`);
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

/**
 * Puts one file on the release as an asset, replacing any asset of the same
 * name so re-running for the same version is safe.
 */
async function uploadAsset(releaseId, name, filePath) {
  const { data: existing } = await github(`/repos/${releasesRepo}/releases/${releaseId}/assets?per_page=100`);
  for (const asset of existing ?? []) {
    if (asset.name === name) await github(`/repos/${releasesRepo}/releases/assets/${asset.id}`, { method: 'DELETE' });
  }
  const bytes = readFileSync(filePath);
  await github(
    `/repos/${releasesRepo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    { method: 'POST', body: bytes, contentType: 'application/octet-stream' },
  );
  console.log(`  uploaded ${name} (${bytes.length} bytes)`);
}

async function publishToGitHub(files) {
  if (!token) {
    throw new Error(
      'ANDAPOS_GITHUB_TOKEN is not set. Create a fine-grained token with write access to ' +
      `${releasesRepo} and export it before running this script.`,
    );
  }
  let release = (await github(`/repos/${releasesRepo}/releases/tags/${tag}`)).data;
  if (!release) {
    console.log(`Creating release ${tag} in ${releasesRepo}…`);
    release = (await github(`/repos/${releasesRepo}/releases`, {
      method: 'POST',
      body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: false }),
      contentType: 'application/json',
    })).data;
  }
  for (const file of files) await uploadAsset(release.id, file.assetName, file.path);
  return `https://github.com/${releasesRepo}/releases/download/${tag}`;
}

function findPackageOutput() {
  const dir = join(root, `release-${version}`);
  if (!existsSync(dir)) throw new Error(`Expected the packaged app at ${dir}`);
  return dir;
}

if (!skipBuild) {
  run('node', ['scripts/check-windows-signing.mjs']);
  run('npm', ['run', 'build']);
}
run('npx', ['electron-builder', '--win', 'nsis']);

const outDir = findPackageOutput();
const manifestSource = readFileSync(join(outDir, 'latest.yml'), 'utf8');
const pathMatch = manifestSource.match(/^path:\s*(.+)$/m);
if (!pathMatch) throw new Error('latest.yml has no path entry to resolve.');

const assetName = pathMatch[1].trim();
const entries = readdirSync(outDir);
const exeFile = entries.find((name) => name.toLowerCase().endsWith('.exe'));
if (!exeFile) throw new Error(`No installer found in ${outDir}`);
const blockmapFile = entries.find((name) => name.endsWith('.exe.blockmap'));

console.log(`\nInstaller: ${exeFile}`);
console.log(`Manifest asset name: ${assetName}`);

const files = [{ assetName, path: join(outDir, exeFile) }];
if (blockmapFile) files.push({ assetName: `${assetName}.blockmap`, path: join(outDir, blockmapFile) });

let downloadBase;
if (binaryBase) {
  downloadBase = binaryBase;
  console.log(`\nUpload ${exeFile} and ${blockmapFile ?? '(no blockmap)'} to ${binaryBase} yourself.`);
} else {
  downloadBase = await publishToGitHub(files);
}

/**
 * The app fetches this from the feed base. The big binary lives on another host,
 * so each file URL in the manifest is repointed at an absolute URL there.
 */
const manifest = manifestSource.replaceAll(assetName, `${downloadBase}/${assetName}`);
mkdirSync(manifestDir, { recursive: true });
writeFileSync(manifestPath, manifest, 'utf8');

console.log(`\nWrote ${manifestPath}`);
console.log(`Feed: ${feedBase}/latest.yml`);
if (binaryBase) {
  console.log(`Binary host: ${downloadBase}`);
} else {
  console.log(`Binary host: ${releasesRepo} (release ${tag})`);
}
console.log('\nNext: commit public/updates/win/latest.yml and push. Vercel serves it, and every till picks it up on its next check.');
