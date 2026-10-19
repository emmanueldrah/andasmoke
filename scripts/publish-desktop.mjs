import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;

const feedBase = (process.env.ANDAPOS_UPDATE_URL || 'https://andasmoke.vercel.app/updates/win').replace(/\/+$/, '');
const releasesRepo = (process.env.ANDAPOS_RELEASES_REPO || 'emmanueldrah/andasmoke').trim();
const token = (process.env.ANDAPOS_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
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
  // Only a release lookup may legitimately miss; everything else must surface.
  if (response.status === 404 && method === 'GET') return { status: 404, data: null };
  if (!response.ok) throw new Error(`GitHub ${method} ${pathname} failed (${response.status}): ${await response.text()}`);
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}

/**
 * Puts one file on the release through its upload_url (GitHub rejects the
 * api.github.com asset path for these uploads), failing loudly on any non-2xx.
 */
async function uploadAsset(uploadUrl, name, filePath) {
  const bytes = readFileSync(filePath);
  const response = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'anda-smoke-hub-publish',
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`Uploading ${name} failed (${response.status}): ${await response.text()}`);
  }
  const asset = await response.json();
  console.log(`  uploaded ${name} -> ${asset.name} (asset ${asset.id})`);
  return asset;
}

async function publishToGitHub(files) {
  if (!token) {
    throw new Error(
      'No GitHub token found. Set GITHUB_TOKEN (provided automatically in CI) or ' +
      `ANDAPOS_GITHUB_TOKEN to a token with write access to ${releasesRepo}.`,
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
  const uploadUrl = (release.upload_url ||
    `https://uploads.github.com/repos/${releasesRepo}/releases/${release.id}/assets`).replace(/\{.*\}$/, '');

  const { data: existing } = await github(`/repos/${releasesRepo}/releases/${release.id}/assets?per_page=100`);
  for (const asset of existing ?? []) {
    // GitHub turns spaces into dots, so compare both spellings.
    if (files.some(file => file.assetName === asset.name || file.assetName.replace(/\s+/g, '.') === asset.name)) {
      await github(`/repos/${releasesRepo}/releases/assets/${asset.id}`, { method: 'DELETE' });
    }
  }
  // GitHub may rename an asset on upload, so keep the URL it actually serves.
  const downloadUrls = new Map();
  for (const file of files) {
    const asset = await uploadAsset(uploadUrl, file.assetName, file.path);
    downloadUrls.set(file.assetName, asset.browser_download_url);
  }
  return downloadUrls;
}

function findPackageOutput() {
  const dir = join(root, `release-${version}`);
  if (!existsSync(dir)) throw new Error(`Expected the packaged app at ${dir}`);
  return dir;
}

/**
 * Electron 44 no longer runs a postinstall, so a clean `npm ci` leaves
 * node_modules/electron/dist missing and electron-builder refuses to package.
 * Run Electron's own installer when that happens (a no-op when it is present).
 */
function ensureElectronRuntime() {
  const electronDir = join(root, 'node_modules', 'electron');
  if (existsSync(join(electronDir, 'dist'))) return;
  console.log('\nElectron runtime missing; downloading it before packaging…');
  run('node', [join(electronDir, 'install.js')]);
}

if (!skipBuild) {
  run('node', ['scripts/check-windows-signing.mjs']);
  run('npm', ['run', 'build']);
}
ensureElectronRuntime();
run('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never']);

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
let downloadUrls = null;
if (binaryBase) {
  downloadBase = binaryBase;
  console.log(`\nUpload ${exeFile} and ${blockmapFile ?? '(no blockmap)'} to ${binaryBase} yourself.`);
} else {
  downloadUrls = await publishToGitHub(files);
}

/**
 * The app fetches this from the feed base. The big binary lives on another host,
 * so each file URL in the manifest is repointed at the absolute URL it is served
 * from — using the name GitHub actually stored, which may differ from ours.
 */
let manifest = manifestSource;
if (downloadUrls) {
  for (const [name, url] of downloadUrls) manifest = manifest.split(name).join(url);
} else {
  manifest = manifest.replaceAll(assetName, `${downloadBase}/${assetName}`);
}
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
