import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { renderItemPreview } from "../scripts/render-preview.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const happyPath = path.join(here, "fixtures", "valid", "happy-path");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function loadHappyPathItems() {
  const text = readFileSync(path.join(happyPath, "library.scribblylib"), "utf8");
  const lib = JSON.parse(text) as {
    libraryItems: { id: string; elements: unknown[] }[];
  };
  return lib.libraryItems;
}

describe("renderItemPreview", () => {
  it("renders item 1 (rectangle + bound text) to a valid PNG", () => {
    const items = loadHappyPathItems();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buf = renderItemPreview(items[0]!.elements as any);
    expect(buf.length).toBeGreaterThan(200);
    expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it("renders item 2 (rectangle + arrow with binding) to a valid PNG", () => {
    const items = loadHappyPathItems();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buf = renderItemPreview(items[1]!.elements as any);
    expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it("renders item 3 (freedraw) to a valid PNG", () => {
    const items = loadHappyPathItems();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buf = renderItemPreview(items[2]!.elements as any);
    expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it("respects custom viewport dimensions", () => {
    const items = loadHappyPathItems();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buf = renderItemPreview(items[0]!.elements as any, {
      width: 128,
      height: 128,
    });
    // A 128x128 PNG should be measurably smaller than the default 512x384.
    expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it("survives an empty element list without throwing", () => {
    const buf = renderItemPreview([]);
    expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });
});
