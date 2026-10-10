const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];

export class ProductImageUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductImageUploadError';
  }
}

async function compressImage(file: File): Promise<File> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (event) => {
      const dataUrl = String(event.target?.result ?? '');
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const MAX = 840;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(file);
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve(file);
              return;
            }
            resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
          },
          'image/jpeg',
          0.78,
        );
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

import { MEDIA_PREFIX } from './media';

const readAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = reject;
  reader.onload = (event) => resolve(String(event.target?.result || ''));
  reader.readAsDataURL(file);
});

/**
 * Uploads a product photo through the server, which writes it into the till's
 * own data folder and returns a local URL. Nothing leaves the computer.
 */
export async function uploadProductImage(file: File, adminToken: string): Promise<string> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new ProductImageUploadError('Use a JPG, PNG, WEBP, or GIF image.');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ProductImageUploadError('Image must be smaller than 10 MB.');
  }

  const compressed = await compressImage(file);
  const dataUrl = await readAsDataUrl(compressed);

  const response = await fetch('/api/products?imageUpload=true', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify({ image: dataUrl }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ProductImageUploadError(error.error || 'Upload failed.');
  }

  const payload = await response.json();
  return payload.url;
}

export const isValidProductImageUrl = (value: unknown): value is string =>
  typeof value === 'string'
  && (value.startsWith(MEDIA_PREFIX) || /^https?:\/\//.test(value) || value.startsWith('data:image/'));