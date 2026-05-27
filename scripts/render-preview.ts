/**
 * scripts/render-preview.ts
 *
 * Headless PNG renderer for library-item previews used in the gallery
 * cards. Wraps @napi-rs/canvas with @scribbly/renderer's renderItemElements
 * so the marketplace gallery's preview pipeline draws elements with the
 * same code path as the Scribbly app.
 *
 * Fonts: @napi-rs/canvas does not bundle Virgil (Scribbly's default
 * hand-drawn font). Text-heavy previews will render in Cairo's system
 * fallback. Authors who care about exact preview parity can embed a
 * data-URL preview in their .scribblylib; build-manifest.ts prefers that
 * when present (a future flag — for now we always rerender).
 *
 * Image elements are not rendered: the marketplace validator rejects them
 * (no base64 binary blobs allowed) and @napi-rs/canvas doesn't have a
 * synchronous `new Image()` global. The draw module skips them silently.
 */

import { createCanvas } from "@napi-rs/canvas";

import {
  renderItemElements,
  type ScribblyElement,
  type Theme,
} from "@scribbly/renderer";

export type PreviewOptions = {
  width?: number;
  height?: number;
  padding?: number;
  background?: string;
  theme?: Theme;
};

const DEFAULTS = {
  width: 512,
  height: 384,
  padding: 24,
  background: "#ffffff",
} as const;

export function renderItemPreview(
  elements: readonly ScribblyElement[],
  options: PreviewOptions = {},
): Buffer {
  const width = options.width ?? DEFAULTS.width;
  const height = options.height ?? DEFAULTS.height;
  const padding = options.padding ?? DEFAULTS.padding;
  const background = options.background ?? DEFAULTS.background;
  const theme: Theme = options.theme ?? "light";

  const canvas = createCanvas(width, height);
  // @napi-rs/canvas's Canvas is HTMLCanvasElement-compatible at the API
  // level Rough.js cares about (`getContext("2d")` returning a 2D context).
  // Cast through `unknown` because the type defs don't overlap.
  renderItemElements(
    canvas as unknown as HTMLCanvasElement,
    elements,
    { viewport: { width, height }, padding, background, theme },
  );
  return canvas.toBuffer("image/png");
}
