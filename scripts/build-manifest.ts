/**
 * scripts/build-manifest.ts
 *
 * Walks `submissions/<handle>/<slug>/`, regenerates `dist/libraries.json` +
 * the preview PNGs + the downloadable `.scribblylib` files in the layout
 * Scribbly's in-app gallery expects:
 *
 *   dist/libraries.json
 *   dist/p/<handle>/<slug>.png
 *   dist/d/<handle>/<slug>-<version>.scribblylib
 *
 * Run on push to main by `.github/workflows/publish.yml`; the dist tree is
 * then uploaded as a Pages artifact and deployed to
 * https://libraries.scribbly.app/.
 *
 * Defensive re-validation: validate.ts already ran on the PR, but if
 * someone bypasses CI we'd rather skip a bad submission than ship it. Any
 * submission that fails validation is logged + omitted from the manifest.
 *
 * publishedAt is preserved across builds by reading the prior manifest
 * (when present). updatedAt is always the current build time.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import { renderItemPreview } from "./render-preview.ts";
import {
  validateSubmission,
  type ManifestEntry as ValidatorManifestEntry,
} from "./validate.ts";

// ---------- Manifest shape (matches PLAN.md "Manifest format" section) ----------

export type ManifestAuthor = {
  handle: string;
  url: string;
  displayName?: string;
};

export type ManifestEntry = {
  slug: string;
  name: string;
  description: string;
  author: ManifestAuthor;
  homepage?: string;
  license: string;
  tags: string[];
  itemCount: number;
  version: string;
  preview: string;
  download: string;
  sha256: string;
  publishedAt: number;
  updatedAt: number;
  deprecated?: boolean;
  deprecationNote?: string;
};

export type Manifest = {
  type: "scribbly-libraries-manifest";
  version: 1;
  generatedAt: number;
  libraries: ManifestEntry[];
};

// ---------- Internal types pulled from disk ----------

type MetaYaml = {
  name: string;
  description: string;
  version: string;
  author: { handle: string; displayName?: string };
  homepage?: string;
  license: string;
  tags: string[];
  previewItemId?: string;
  deprecated?: boolean;
  deprecationNote?: string;
};

type ScribblyLib = {
  libraryItems: Array<{ id: string; elements: unknown[] }>;
};

// ---------- Public entry point (testable) ----------

export type BuildOptions = {
  submissionsDir: string;
  distDir: string;
  baseUrl: string;
  // Previous build's manifest (optional). Used to preserve publishedAt
  // across builds and to verify SHA-256 stability for same-version
  // republishes (defense in depth; validate.ts already enforces this on
  // PRs).
  priorManifest?: Manifest | null;
  now?: number;
};

export type BuildResult = {
  manifest: Manifest;
  skipped: Array<{ slug: string; reason: string }>;
};

export function buildManifest(opts: BuildOptions): BuildResult {
  const { submissionsDir, distDir, baseUrl, priorManifest } = opts;
  const now = opts.now ?? Date.now();

  ensureDir(distDir);
  ensureDir(path.join(distDir, "p"));
  ensureDir(path.join(distDir, "d"));

  const priorEntries = new Map<string, ManifestEntry>();
  if (priorManifest) {
    for (const e of priorManifest.libraries) priorEntries.set(e.slug, e);
  }

  // Build the validator's "previous version + sha" view from the prior
  // manifest so re-validation here behaves the same way it does in CI.
  const validatorManifest: ValidatorManifestEntry[] = priorManifest
    ? priorManifest.libraries.map((e) => ({
        slug: e.slug,
        version: e.version,
        sha256: e.sha256,
      }))
    : [];

  const entries: ManifestEntry[] = [];
  const skipped: Array<{ slug: string; reason: string }> = [];

  if (!existsSync(submissionsDir)) {
    return {
      manifest: {
        type: "scribbly-libraries-manifest",
        version: 1,
        generatedAt: now,
        libraries: [],
      },
      skipped,
    };
  }

  for (const handle of readdirSync(submissionsDir)) {
    const handleDir = path.join(submissionsDir, handle);
    if (!statSync(handleDir).isDirectory()) continue;
    for (const slug of readdirSync(handleDir)) {
      const slugDir = path.join(handleDir, slug);
      if (!statSync(slugDir).isDirectory()) continue;
      const fullSlug = `${handle}/${slug}`;

      // Defensive re-validate: a bad submission shouldn't ship even if it
      // somehow merged.
      const result = validateSubmission(slugDir, {
        manifest: validatorManifest,
      });
      if (!result.ok) {
        skipped.push({
          slug: fullSlug,
          reason: result.errors.map((e) => `[${e.rule}] ${e.message}`).join("; "),
        });
        continue;
      }

      const libPath = path.join(slugDir, "library.scribblylib");
      const metaPath = path.join(slugDir, "meta.yaml");
      const libBuf = readFileSync(libPath);
      const lib = JSON.parse(libBuf.toString("utf8")) as ScribblyLib;
      const meta = parseYaml(readFileSync(metaPath, "utf8")) as MetaYaml;

      const sha256 = createHash("sha256").update(libBuf).digest("hex");

      // Preview: prefer the previewItemId from meta, else the first item.
      // Render a fresh PNG every build — embedded data-URL previews are
      // ignored to keep the gallery aesthetic consistent.
      const previewItem =
        (meta.previewItemId
          ? lib.libraryItems.find((i) => i.id === meta.previewItemId)
          : null) ?? lib.libraryItems[0];
      if (!previewItem) {
        skipped.push({
          slug: fullSlug,
          reason: "no items to render as preview (libraryItems is empty)",
        });
        continue;
      }
      const previewBuf = renderItemPreview(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        previewItem.elements as any,
      );
      const previewDir = path.join(distDir, "p", handle);
      ensureDir(previewDir);
      writeFileSync(path.join(previewDir, `${slug}.png`), previewBuf);

      // Download: copy .scribblylib to a versioned path so old links stay
      // valid after a version bump.
      const downloadDir = path.join(distDir, "d", handle);
      ensureDir(downloadDir);
      const downloadName = `${slug}-${meta.version}.scribblylib`;
      writeFileSync(path.join(downloadDir, downloadName), libBuf);

      const prior = priorEntries.get(fullSlug);
      const publishedAt = prior?.publishedAt ?? now;

      const entry: ManifestEntry = {
        slug: fullSlug,
        name: meta.name,
        description: meta.description,
        author: {
          handle,
          url: `https://github.com/${handle}`,
          ...(meta.author.displayName
            ? { displayName: meta.author.displayName }
            : {}),
        },
        license: meta.license,
        tags: meta.tags,
        itemCount: lib.libraryItems.length,
        version: meta.version,
        preview: `${baseUrl}/p/${handle}/${slug}.png`,
        download: `${baseUrl}/d/${handle}/${downloadName}`,
        sha256,
        publishedAt,
        updatedAt: now,
      };
      if (meta.homepage) entry.homepage = meta.homepage;
      if (meta.deprecated) entry.deprecated = true;
      if (meta.deprecationNote) entry.deprecationNote = meta.deprecationNote;

      entries.push(entry);
    }
  }

  // Sort by slug for stable diffs across builds.
  entries.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const manifest: Manifest = {
    type: "scribbly-libraries-manifest",
    version: 1,
    generatedAt: now,
    libraries: entries,
  };
  writeFileSync(
    path.join(distDir, "libraries.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(path.join(distDir, "index.html"), indexHtml(manifest), "utf8");
  return { manifest, skipped };
}

function indexHtml(manifest: Manifest): string {
  // Tiny humans-only landing page. The in-app gallery reads libraries.json
  // directly; this exists so libraries.scribbly.app/ doesn't 404.
  const entries = manifest.libraries
    .map(
      (l) =>
        `<li><strong>${escapeHtml(l.name)}</strong> by ${escapeHtml(l.author.handle)} — <a href="${escapeHtml(l.download)}">.scribblylib</a></li>`,
    )
    .join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Scribbly Libraries</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 4rem auto; padding: 0 1rem; color: #1e1e1e; }
    code { background: #f3f4f6; padding: 0.1em 0.4em; border-radius: 3px; }
    a { color: #4c5fd1; }
  </style>
</head>
<body>
  <h1>Scribbly Libraries</h1>
  <p>Community-curated library packs for <a href="https://scribbly.app">Scribbly</a>.</p>
  <p>The in-app gallery reads <a href="./libraries.json"><code>libraries.json</code></a>. Submissions are reviewed via PR in <a href="https://github.com/scribbly/scribbly-libraries">scribbly/scribbly-libraries</a>.</p>
  <h2>${manifest.libraries.length} libraries</h2>
  <ul>
      ${entries || "<li>(none yet)</li>"}
  </ul>
  <p><small>Generated ${new Date(manifest.generatedAt).toISOString()}</small></p>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------- CLI ----------

function defaultRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function loadPriorManifest(distDir: string): Manifest | null {
  const p = path.join(distDir, "libraries.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const root = defaultRoot();
  let submissionsDir = path.join(root, "submissions");
  let distDir = path.join(root, "dist");
  let baseUrl = "https://libraries.scribbly.app";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--submissions") {
      submissionsDir = path.resolve(args[++i]!);
    } else if (a === "--dist") {
      distDir = path.resolve(args[++i]!);
    } else if (a === "--base-url") {
      baseUrl = args[++i]!;
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  const priorManifest = loadPriorManifest(distDir);
  const { manifest, skipped } = buildManifest({
    submissionsDir,
    distDir,
    baseUrl,
    priorManifest,
  });
  console.log(
    `Built manifest: ${manifest.libraries.length} libraries, ${skipped.length} skipped`,
  );
  for (const s of skipped) {
    console.error(`SKIPPED ${s.slug}: ${s.reason}`);
  }
  if (skipped.length > 0) process.exit(1);
}

const isCliEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/^\//, "")}`;
if (isCliEntrypoint) {
  main();
}
