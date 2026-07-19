import sharp, { type Sharp } from 'sharp';

/**
 * Lightweight transform parameters for public image delivery.
 *
 * Applied only on `GET /api/public/files/:fileId`:
 * - `w` / `h`    without crop: target width/height for proportional downscale
 * - `x` / `y`    crop origin (px); when present, `w`/`h` define the crop box
 * - `cw` / `ch`  explicit crop size (may coexist with scale `w`: crop then resize)
 * - `format`     `webp` | `avif` | `auto`
 * - `preset`     `sm` | `md` | `lg` → w=320|960|1600 + format=webp (overridable)
 *
 * With no parameters the original bytes are streamed as-is.
 */

export const IMAGE_PRESETS = {
  sm: { width: 320, format: 'webp' as const },
  md: { width: 960, format: 'webp' as const },
  lg: { width: 1600, format: 'webp' as const },
} as const;

export type ImagePresetName = keyof typeof IMAGE_PRESETS;

const MIN_WIDTH = 16;
const MAX_WIDTH = 2048;
const MIN_HEIGHT = 16;
const MAX_HEIGHT = 2048;
const MAX_CROP_EDGE = 8192;
const MAX_INPUT_PIXELS = 50_000_000;
const WEBP_QUALITY = 82;
const AVIF_QUALITY = 50;
const AVIF_EFFORT = 4;

export type ImageTransformFormat = 'webp' | 'avif';

export interface ImageCropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ImageTransformOptions {
  /** Proportional resize width applied after crop. */
  width?: number;
  /** Proportional resize height applied after crop; with width uses fit=inside. */
  height?: number;
  /** Crop rectangle in source image pixels. */
  crop?: ImageCropRect;
  format?: ImageTransformFormat;
  negotiated?: boolean;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Parse image-transform query parameters.
 * Compatible with common image-host style: `?x=100&y=80&w=800&h=450&format=webp`
 * - with x/y: w/h are treated as the crop box
 * - without x/y: w/h are resize targets
 * - cw/ch can set crop explicitly while w remains a post-crop scale
 */
export function parseImageTransformOptions(
  rawWidth: string | undefined,
  rawFormat: string | undefined,
  acceptHeader?: string,
  rawHeight?: string,
  rawX?: string,
  rawY?: string,
  rawCropWidth?: string,
  rawCropHeight?: string,
  rawPreset?: string,
): ImageTransformOptions {
  const options: ImageTransformOptions = {};

  // Preset first: explicit w/format/crop params below can override.
  const presetKey = (rawPreset || '').toLowerCase().trim() as ImagePresetName;
  if (presetKey in IMAGE_PRESETS) {
    const preset = IMAGE_PRESETS[presetKey];
    options.width = preset.width;
    options.format = preset.format;
  }

  const x = parsePositiveInt(rawX);
  const y = parsePositiveInt(rawY);
  const w = parsePositiveInt(rawWidth);
  const h = parsePositiveInt(rawHeight);
  const cw = parsePositiveInt(rawCropWidth);
  const ch = parsePositiveInt(rawCropHeight);

  const hasOrigin = x !== undefined || y !== undefined;
  const hasExplicitCrop = cw !== undefined || ch !== undefined;

  if (hasExplicitCrop) {
    const cropW = cw ?? w;
    const cropH = ch ?? h;
    if (cropW && cropH && cropW > 0 && cropH > 0) {
      options.crop = {
        left: clamp(x ?? 0, 0, MAX_CROP_EDGE),
        top: clamp(y ?? 0, 0, MAX_CROP_EDGE),
        width: clamp(cropW, 1, MAX_CROP_EDGE),
        height: clamp(cropH, 1, MAX_CROP_EDGE),
      };
      // With explicit cw/ch, w may still act as post-crop scale when it differs from cw.
      if (w !== undefined && (cw === undefined || w !== cw)) {
        options.width = clamp(w, MIN_WIDTH, MAX_WIDTH);
      }
      if (h !== undefined && (ch === undefined || h !== ch) && options.width === undefined) {
        options.height = clamp(h, MIN_HEIGHT, MAX_HEIGHT);
      }
    }
  } else if (hasOrigin) {
    // Image-host convention: x/y + w/h defines the crop box.
    if (w && h && w > 0 && h > 0) {
      options.crop = {
        left: clamp(x ?? 0, 0, MAX_CROP_EDGE),
        top: clamp(y ?? 0, 0, MAX_CROP_EDGE),
        width: clamp(w, 1, MAX_CROP_EDGE),
        height: clamp(h, 1, MAX_CROP_EDGE),
      };
    }
  } else {
    // Pure resize; explicit w/h overrides preset width.
    if (w !== undefined && w > 0) {
      options.width = clamp(w, MIN_WIDTH, MAX_WIDTH);
    }
    if (h !== undefined && h > 0) {
      options.height = clamp(h, MIN_HEIGHT, MAX_HEIGHT);
    }
  }

  const fmt = (rawFormat || '').toLowerCase();
  if (fmt === 'webp') {
    options.format = 'webp';
  } else if (fmt === 'avif') {
    options.format = 'avif';
  } else if (fmt === 'auto') {
    options.format = (acceptHeader || '').toLowerCase().includes('image/avif') ? 'avif' : 'webp';
    options.negotiated = true;
  }

  return options;
}

export function hasImageTransform(options: ImageTransformOptions): boolean {
  return (
    options.width !== undefined ||
    options.height !== undefined ||
    options.crop !== undefined ||
    options.format !== undefined
  );
}

/** Width used by ImagePipelineService THUMB derivatives. */
export const STORED_THUMB_WIDTH = 320;

/**
 * True when the request matches the pre-generated THUMB derivative
 * (320px wide webp, no crop, no height constraint).
 */
export function matchesStoredThumb(options: ImageTransformOptions): boolean {
  if (options.crop || options.height !== undefined) {
    return false;
  }
  if (options.width !== STORED_THUMB_WIDTH) {
    return false;
  }
  // Pipeline always writes webp; only short-circuit when client asks for webp.
  return options.format === 'webp';
}

export function createImageTransformStream(options: ImageTransformOptions): Sharp {
  const transformer = sharp({ failOn: 'none', limitInputPixels: MAX_INPUT_PIXELS });

  // Apply EXIF orientation before crop so mobile photos keep a consistent coordinate space.
  transformer.rotate();

  if (options.crop) {
    transformer.extract({
      left: options.crop.left,
      top: options.crop.top,
      width: options.crop.width,
      height: options.crop.height,
    });
  }

  if (options.width !== undefined || options.height !== undefined) {
    transformer.resize({
      width: options.width,
      height: options.height,
      fit: options.width && options.height ? 'inside' : 'inside',
      withoutEnlargement: true,
    });
  }

  if (options.format === 'webp') {
    transformer.webp({ quality: WEBP_QUALITY });
  } else if (options.format === 'avif') {
    transformer.avif({ quality: AVIF_QUALITY, effort: AVIF_EFFORT });
  }

  return transformer;
}

export function resolveTransformedContentType(options: ImageTransformOptions): string | undefined {
  if (options.format === 'webp') {
    return 'image/webp';
  }
  if (options.format === 'avif') {
    return 'image/avif';
  }
  return undefined;
}
