/**
 * Where product photos live, and how the renderer refers to them.
 *
 * Photos used to be uploaded to Supabase Storage over the internet. This build
 * is offline-first, so images are written into the till's own data folder and
 * served back by the local server under /media/.
 *
 * This module is browser-safe on purpose: the renderer needs the URL prefix to
 * decide whether an image can be displayed, but it must not pull `node:fs`
 * into the bundle. The disk work happens in electron/media.cjs.
 */
import { getDataDir } from './paths.js';

export const MEDIA_PREFIX = '/media/products/';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** True when the value is a photo this app stored on this machine. */
export const isStoredMediaImage = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(MEDIA_PREFIX);

/** True when a browser can display the value as an image source. */
export const isRenderableProductImage = (value: unknown): value is string =>
  typeof value === 'string'
  && (value.startsWith('data:image/') || value.startsWith(MEDIA_PREFIX) || /^https?:\/\//.test(value));

/** Data-folder-relative location of the media root, used by the disk helper. */
export const mediaDirRelative = 'media/products';

export { EXTENSION_BY_MIME, getDataDir };