export {
  isRenderableProductImage,
  isStoredMediaImage,
  MEDIA_PREFIX,
} from './media';

export const productImageUrls = (images: unknown[]): string[] =>
  Array.from(new Set(images.filter(
    (image): image is string => typeof image === 'string'
      && (image.startsWith('data:image/') || image.startsWith('/media/products/') || /^https?:\/\//.test(image)),
  )));