import sharp, { type Sharp } from 'sharp';

/** Bound the decode work for watermarking (mirrors image-transform). */
const MAX_INPUT_PIXELS = 50_000_000;

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (char) => {
    switch (char) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/**
 * Build a sharp transform that tiles a semi-transparent text watermark across an
 * image. Used for share links that opt into a watermark, so previewed/downloaded
 * images carry an attribution/ownership mark. Re-encodes in the source format.
 *
 * On decode failure (corrupt/non-image) sharp emits an 'error' the caller must
 * handle, falling back gracefully.
 */
export function createWatermarkStream(text: string): Sharp {
  const label = escapeXml(text.trim().slice(0, 64)) || 'watermark';
  const tile = Buffer.from(
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="340" height="200">',
      `<text x="16" y="110" transform="rotate(-30 170 100)" font-family="sans-serif" font-size="26" fill="rgba(15,23,42,0.20)">${label}</text>`,
      '</svg>',
    ].join(''),
  );

  const transformer = sharp({ failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS });
  // Apply EXIF orientation first so the watermark lands the right way up.
  transformer.rotate();
  transformer.composite([{ input: tile, tile: true, blend: 'over' }]);
  return transformer;
}
