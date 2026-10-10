/**
 * Local product media store (server side).
 *
 * `src/lib/media.ts` owns the shared constants and URL rules but must stay
 * browser-safe, so the disk work lives here and is loaded by the local server
 * and the API bundle. Keeping the path checks in one place stops the served URL
 * and the stored file from ever disagreeing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MEDIA_PREFIX = '/media/products/';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const EXTENSION_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** The till's data folder. */
function getDataDir() {
  return path.resolve(process.env.ANDA_DATA_DIR || path.join(process.cwd(), '.data'));
}

function getMediaDir() {
  const dir = path.join(getDataDir(), 'media', 'products');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Writes a data URL to disk and returns the local URL to render.
 *
 * Rejects anything that is not a small enough base64 image, so a hostile or
 * mistaken payload cannot fill the disk.
 */
function saveProductImage(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('Image data is required.');

  const match = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error('Use a JPG, PNG, WEBP, or GIF image.');

  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) throw new Error('Image data was empty.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Image must be smaller than 10 MB.');

  const extension = EXTENSION_BY_MIME[match[1]] || 'jpg';
  const day = new Date().toISOString().slice(0, 10);
  const dayDir = path.join(getMediaDir(), day);
  if (!fs.existsSync(dayDir)) fs.mkdirSync(dayDir, { recursive: true });

  const filename = `${day}-${randomUUID()}.${extension}`;
  fs.writeFileSync(path.join(dayDir, filename), bytes);
  return `${MEDIA_PREFIX}${day}/${filename}`;
}

/**
 * Maps a stored media URL to an absolute file, or null when it is not one of
 * ours, tries to escape the media folder, or no longer exists on disk.
 */
function resolveStoredMediaPath(value) {
  if (typeof value !== 'string' || !value.startsWith(MEDIA_PREFIX)) return null;
  const relative = value.slice(MEDIA_PREFIX.length);
  if (!relative) return null;

  const root = getMediaDir().replace(/\\/g, '/');
  const target = path.join(root, ...relative.split('/')).replace(/\\/g, '/');
  if (!target.startsWith(`${root}/`)) return null;

  return fs.existsSync(target) ? target : null;
}

module.exports = {
  MEDIA_PREFIX,
  MAX_IMAGE_BYTES,
  EXTENSION_BY_MIME,
  getMediaDir,
  saveProductImage,
  resolveStoredMediaPath,
};