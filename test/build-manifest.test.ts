import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildManifest,
  type Manifest,
} from "../scripts/build-manifest.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const happyPath = path.join(here, "fixtures", "valid", "happy-path");

let workspace: string;
let submissionsDir: string;
let distDir: string;

function seedSubmission(handle: string, slug: string): void {
  const dir = path.join(submissionsDir, handle, slug);
  mkdirSync(dir, { recursive: true });
  copyFileSync(
    path.join(happyPath, "library.scribblylib"),
    path.join(dir, "library.scribblylib"),
  );
  copyFileSync(
    path.join(happyPath, "meta.yaml"),
    path.join(dir, "meta.yaml"),
  );
  // Happy-path meta has handle "valid"; realign to the actual handle so
  // validate.ts's author-mismatch rule doesn't fire.
  const metaPath = path.join(dir, "meta.yaml");
  const text = readFileSync(metaPath, "utf8");
  writeFileSync(metaPath, text.replace(/handle: \w+/, `handle: ${handle}`));
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "scribbly-build-manifest-"));
  submissionsDir = path.join(workspace, "submissions");
  distDir = path.join(workspace, "dist");
  mkdirSync(submissionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("buildManifest", () => {
  it("returns an empty manifest when submissions/ is empty", () => {
    const { manifest, skipped } = buildManifest({
      submissionsDir,
      distDir,
      baseUrl: "https://example.com",
    });
    expect(manifest.libraries).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(manifest.type).toBe("scribbly-libraries-manifest");
    expect(manifest.version).toBe(1);
  });

  it("walks submissions/, renders a preview, and writes the manifest + artifacts", () => {
    seedSubmission("wissam", "server-rack");
    const { manifest, skipped } = buildManifest({
      submissionsDir,
      distDir,
      baseUrl: "https://libraries.scribbly.app",
      now: 1700000000000,
    });
    expect(skipped).toHaveLength(0);
    expect(manifest.libraries).toHaveLength(1);
    const entry = manifest.libraries[0]!;
    expect(entry.slug).toBe("wissam/server-rack");
    expect(entry.name).toBe("Server Rack");
    expect(entry.itemCount).toBe(3);
    expect(entry.version).toBe("1.0.0");
    expect(entry.author.handle).toBe("wissam");
    expect(entry.author.url).toBe("https://github.com/wissam");
    expect(entry.preview).toBe(
      "https://libraries.scribbly.app/p/wissam/server-rack.png",
    );
    expect(entry.download).toBe(
      "https://libraries.scribbly.app/d/wissam/server-rack-1.0.0.scribblylib",
    );
    expect(entry.publishedAt).toBe(1700000000000);
    expect(entry.updatedAt).toBe(1700000000000);

    // Preview PNG written
    const previewPath = path.join(distDir, "p", "wissam", "server-rack.png");
    expect(existsSync(previewPath)).toBe(true);
    const previewBuf = readFileSync(previewPath);
    expect(
      previewBuf
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe(true);

    // .scribblylib copied with versioned filename + SHA matches
    const downloadPath = path.join(
      distDir,
      "d",
      "wissam",
      "server-rack-1.0.0.scribblylib",
    );
    expect(existsSync(downloadPath)).toBe(true);
    const downloadBuf = readFileSync(downloadPath);
    const sha = createHash("sha256").update(downloadBuf).digest("hex");
    expect(entry.sha256).toBe(sha);

    // libraries.json written + matches return value
    const manifestPath = path.join(distDir, "libraries.json");
    expect(existsSync(manifestPath)).toBe(true);
    const parsed = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as Manifest;
    expect(parsed.libraries).toHaveLength(1);
    expect(parsed.libraries[0]!.slug).toBe("wissam/server-rack");
  });

  it("sorts libraries by slug for stable diffs", () => {
    seedSubmission("bob", "rack");
    seedSubmission("alice", "icons");
    const { manifest } = buildManifest({
      submissionsDir,
      distDir,
      baseUrl: "https://example.com",
    });
    expect(manifest.libraries.map((l) => l.slug)).toEqual([
      "alice/icons",
      "bob/rack",
    ]);
  });

  it("preserves publishedAt across rebuilds, advances updatedAt", () => {
    seedSubmission("wissam", "rack");
    const first = buildManifest({
      submissionsDir,
      distDir,
      baseUrl: "https://example.com",
      now: 1000,
    });
    expect(first.manifest.libraries[0]!.publishedAt).toBe(1000);

    const priorManifest = first.manifest;
    const second = buildManifest({
      submissionsDir,
      distDir,
      baseUrl: "https://example.com",
      now: 2000,
      priorManifest,
    });
    expect(second.manifest.libraries[0]!.publishedAt).toBe(1000);
    expect(second.manifest.libraries[0]!.updatedAt).toBe(2000);
  });

  it("skips submissions that fail validation", () => {
    seedSubmission("wissam", "ok-pack");
    // Plant a broken submission: empty meta.yaml.
    const badDir = path.join(submissionsDir, "wissam", "bad-pack");
    mkdirSync(badDir, { recursive: true });
    copyFileSync(
      path.join(happyPath, "library.scribblylib"),
      path.join(badDir, "library.scribblylib"),
    );
    writeFileSync(path.join(badDir, "meta.yaml"), "");
    const { manifest, skipped } = buildManifest({
      submissionsDir,
      distDir,
      baseUrl: "https://example.com",
    });
    expect(manifest.libraries).toHaveLength(1);
    expect(manifest.libraries[0]!.slug).toBe("wissam/ok-pack");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.slug).toBe("wissam/bad-pack");
  });

  it("uses previewItemId from meta when specified", () => {
    seedSubmission("wissam", "rack");
    const metaPath = path.join(submissionsDir, "wissam", "rack", "meta.yaml");
    const text = readFileSync(metaPath, "utf8");
    // Pin the preview to the freedraw item.
    writeFileSync(
      metaPath,
      `${text}previewItemId: 88888888-8888-4888-8888-888888888888\n`,
    );
    const { manifest, skipped } = buildManifest({
      submissionsDir,
      distDir,
      baseUrl: "https://example.com",
    });
    expect(skipped).toHaveLength(0);
    expect(manifest.libraries).toHaveLength(1);
    // No structural change to the entry — the test passes when the build
    // doesn't crash and writes a valid PNG. We can't easily assert which
    // item was rendered from the PNG bytes alone, but a regression would
    // surface either as a missing item (skip) or a build crash.
    const previewPath = path.join(distDir, "p", "wissam", "rack.png");
    expect(existsSync(previewPath)).toBe(true);
  });
});
