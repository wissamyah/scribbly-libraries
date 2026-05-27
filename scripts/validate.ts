/**
 * scripts/validate.ts
 *
 * Runs in CI on every PR against `scribbly-libraries`. Catches every rule
 * listed in the PLAN's "Automated rules" table that can't be expressed in
 * pure JSON Schema. Schema-shape rules are delegated to ajv against the two
 * files in `schemas/`.
 *
 * Exit code: 0 on all-pass, 1 if any submission failed.
 * Each rejection is printed as a single line:
 *   FAIL <slug> [<ruleKey>] <message>
 *
 * Library API is exported for tests; CLI is the `main()` block at the bottom.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse as parseYaml } from "yaml";

// ---------- Types ----------

export const RULE_KEYS = {
  badSubmissionPath: "bad-submission-path",
  missingFile: "missing-file",
  unexpectedFile: "unexpected-file",
  fileTooLarge: "file-too-large",
  notJson: "not-json",
  notYaml: "not-yaml",
  schemaScribblylib: "schema-scribblylib",
  schemaMeta: "schema-meta",
  tooFewItems: "too-few-items",
  trivialItem: "trivial-item",
  danglingContainer: "dangling-container",
  danglingBinding: "dangling-binding",
  danglingGroupId: "dangling-groupid",
  danglingFrameId: "dangling-frameid",
  nonEnglishTextContent: "non-english-text-content",
  nonEnglishMeta: "non-english-meta",
  authorMismatch: "author-mismatch",
  slugConflictHistory: "slug-conflict-history",
  versionNotMonotonic: "version-not-monotonic",
  shaInstability: "sha-instability",
} as const;

export type RuleKey = (typeof RULE_KEYS)[keyof typeof RULE_KEYS];

export type ValidationError = {
  rule: RuleKey;
  path: string;
  message: string;
};

export type ValidationResult =
  | { ok: true; slug: string }
  | { ok: false; slug: string; errors: ValidationError[] };

export type ManifestEntry = {
  slug: string;
  version: string;
  sha256: string;
};

export type ValidateOptions = {
  schemasDir?: string;
  prAuthor?: string;
  previouslyKnownSlugs?: ReadonlyMap<string, string>;
  manifest?: ReadonlyArray<ManifestEntry>;
  maxFileSizeBytes?: number;
};

const DEFAULTS = {
  maxFileSizeBytes: 512 * 1024,
};

// ---------- Ajv setup ----------

let cachedValidators: {
  scribblylib: ValidateFunction;
  meta: ValidateFunction;
} | null = null;

function getValidators(schemasDir: string) {
  if (cachedValidators) return cachedValidators;
  const scribblySchema = JSON.parse(
    readFileSync(path.join(schemasDir, "scribblylib.schema.json"), "utf8"),
  );
  const metaSchema = JSON.parse(
    readFileSync(path.join(schemasDir, "meta.schema.json"), "utf8"),
  );
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  cachedValidators = {
    scribblylib: ajv.compile(scribblySchema),
    meta: ajv.compile(metaSchema),
  };
  return cachedValidators;
}

function ajvErrorsToValidationErrors(
  errs: ErrorObject[] | null | undefined,
  rule: RuleKey,
  filePath: string,
): ValidationError[] {
  if (!errs || errs.length === 0) return [];
  return errs.map((e) => ({
    rule,
    path: `${filePath}${e.instancePath ?? ""}`,
    message: `${e.message ?? "schema violation"}${
      e.params ? ` (${JSON.stringify(e.params)})` : ""
    }`,
  }));
}

// ---------- Element-shape (post-schema; schema guarantees these fields exist) ----------

type AnyElement = {
  id: string;
  type: string;
  groupId?: string | null;
  frameId?: string | null;
  containerId?: string | null;
  text?: string;
  points?: ReadonlyArray<readonly [number, number]>;
  bendPoint?: readonly [number, number] | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
};

type LibraryItem = {
  id: string;
  name: string;
  elements: AnyElement[];
};

type ScribblyLib = {
  type: "scribblylib";
  version: 1;
  source: string;
  libraryItems: LibraryItem[];
};

type Meta = {
  name: string;
  description: string;
  version: string;
  author: { handle: string; displayName?: string };
  license: string;
  tags: string[];
};

// ---------- Pure rule functions (each tested independently) ----------

/**
 * The PLAN's English-text heuristic: ≥ 90 % of characters in basic Latin
 * printable + ASCII whitespace. Empty strings pass (caller is responsible
 * for length checks elsewhere).
 */
export function isEnglishish(text: string, threshold = 0.9): boolean {
  if (text.length === 0) return true;
  let ok = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // 0x20–0x7E printable ASCII, plus \t \n \r
    if ((c >= 0x20 && c <= 0x7e) || c === 0x09 || c === 0x0a || c === 0x0d) {
      ok++;
    }
  }
  return ok / text.length >= threshold;
}

/**
 * "Each item ≥ 2 elements OR a non-trivial single element."
 * Returns true when the item is trivial (single trivial element).
 */
export function isItemTrivial(item: LibraryItem): boolean {
  if (item.elements.length >= 2) return false;
  if (item.elements.length === 0) return true;
  const el = item.elements[0]!;
  switch (el.type) {
    case "freedraw":
      return (el.points?.length ?? 0) <= 10;
    case "text":
      return (el.text ?? "").trim().length === 0;
    case "line":
      return (el.points?.length ?? 0) <= 2;
    case "arrow":
      return (el.points?.length ?? 0) <= 2 && !el.bendPoint;
    case "rectangle":
    case "ellipse":
    case "frame":
      return true;
    default:
      return true;
  }
}

/**
 * Self-containment check for one item.
 * Every groupId, frameId, containerId, and arrow binding elementId must
 * reference another element *in the same item*. groupId additionally must
 * have at least one peer in the item (a singleton group is dangling — it
 * has no peers, so the grouping intent is meaningless).
 */
export function checkSelfContainment(
  item: LibraryItem,
  itemPath: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const ids = new Set(item.elements.map((e) => e.id));

  // groupId peer count
  const groupCounts = new Map<string, number>();
  for (const el of item.elements) {
    if (el.groupId) {
      groupCounts.set(el.groupId, (groupCounts.get(el.groupId) ?? 0) + 1);
    }
  }
  for (const el of item.elements) {
    const ePath = `${itemPath}/elements[id=${el.id}]`;

    if (el.containerId && !ids.has(el.containerId)) {
      errors.push({
        rule: RULE_KEYS.danglingContainer,
        path: ePath,
        message: `containerId ${el.containerId} does not refer to an element in this item`,
      });
    }
    if (el.frameId && !ids.has(el.frameId)) {
      errors.push({
        rule: RULE_KEYS.danglingFrameId,
        path: ePath,
        message: `frameId ${el.frameId} does not refer to an element in this item`,
      });
    }
    if (el.groupId && (groupCounts.get(el.groupId) ?? 0) < 2) {
      errors.push({
        rule: RULE_KEYS.danglingGroupId,
        path: ePath,
        message: `groupId ${el.groupId} has no peer elements in this item — singleton groups are not allowed`,
      });
    }
    if (el.type === "arrow") {
      if (el.startBinding && !ids.has(el.startBinding.elementId)) {
        errors.push({
          rule: RULE_KEYS.danglingBinding,
          path: `${ePath}/startBinding`,
          message: `startBinding.elementId ${el.startBinding.elementId} not in this item`,
        });
      }
      if (el.endBinding && !ids.has(el.endBinding.elementId)) {
        errors.push({
          rule: RULE_KEYS.danglingBinding,
          path: `${ePath}/endBinding`,
          message: `endBinding.elementId ${el.endBinding.elementId} not in this item`,
        });
      }
    }
  }
  return errors;
}

/**
 * Collect every text label inside a library item — the in-item text that
 * the English heuristic applies to (item name + text element contents).
 * Each entry pairs the text with its location for error reporting.
 */
function collectItemTexts(
  item: LibraryItem,
  itemIndex: number,
): Array<{ text: string; path: string }> {
  const out: Array<{ text: string; path: string }> = [];
  out.push({ text: item.name, path: `libraryItems[${itemIndex}]/name` });
  for (const el of item.elements) {
    if (el.type === "text" && typeof el.text === "string") {
      out.push({
        text: el.text,
        path: `libraryItems[${itemIndex}]/elements[id=${el.id}]/text`,
      });
    }
  }
  return out;
}

/**
 * SHA-256 hex of a Buffer. Used for the manifest stability rule.
 */
export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Strict semver compare. Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Schema already validates the shape `MAJOR.MINOR.PATCH`.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

// ---------- Submission orchestrator ----------

const ALLOWED_FILES = new Set(["library.scribblylib", "meta.yaml"]);
const LIBRARY_FILE = "library.scribblylib";
const META_FILE = "meta.yaml";
const HANDLE_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

/**
 * Given the absolute path of a submission directory, extract
 * { handle, slug } from the last two segments and validate their shape.
 *
 * The strict "parent must be 'submissions'" check is enforced by
 * validateAll() when walking the real `submissions/` tree. Per-submission
 * validation only checks the last two segments so test fixtures (which
 * live under test/fixtures/...) can be passed in directly.
 */
function parseSubmissionPath(
  dir: string,
): { handle: string; slug: string } | { error: ValidationError } {
  const parts = path.normalize(dir).split(path.sep).filter(Boolean);
  if (parts.length < 2) {
    return {
      error: {
        rule: RULE_KEYS.badSubmissionPath,
        path: dir,
        message: "expected <handle>/<slug> path segments",
      },
    };
  }
  const slug = parts[parts.length - 1]!;
  const handle = parts[parts.length - 2]!;
  if (!HANDLE_REGEX.test(handle)) {
    return {
      error: {
        rule: RULE_KEYS.badSubmissionPath,
        path: dir,
        message: `handle '${handle}' does not match ${HANDLE_REGEX}`,
      },
    };
  }
  if (!SLUG_REGEX.test(slug)) {
    return {
      error: {
        rule: RULE_KEYS.badSubmissionPath,
        path: dir,
        message: `slug '${slug}' does not match ${SLUG_REGEX}`,
      },
    };
  }
  return { handle, slug };
}

export function validateSubmission(
  dir: string,
  opts: ValidateOptions = {},
): ValidationResult {
  const schemasDir = opts.schemasDir ?? defaultSchemasDir();
  const maxBytes = opts.maxFileSizeBytes ?? DEFAULTS.maxFileSizeBytes;

  const parsed = parseSubmissionPath(dir);
  if ("error" in parsed) {
    return { ok: false, slug: dir, errors: [parsed.error] };
  }
  const { handle, slug } = parsed;
  const fullSlug = `${handle}/${slug}`;

  const errors: ValidationError[] = [];

  // 1. Files in directory: only library.scribblylib + meta.yaml (no strays;
  //    preview.png is generated on merge, not committed by hand).
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    return {
      ok: false,
      slug: fullSlug,
      errors: [
        {
          rule: RULE_KEYS.badSubmissionPath,
          path: dir,
          message: `cannot read directory: ${(e as Error).message}`,
        },
      ],
    };
  }
  for (const name of entries) {
    if (!ALLOWED_FILES.has(name)) {
      errors.push({
        rule: RULE_KEYS.unexpectedFile,
        path: path.join(dir, name),
        message: `unexpected file '${name}' — submissions may contain only ${[...ALLOWED_FILES].join(", ")}`,
      });
    }
  }
  for (const required of ALLOWED_FILES) {
    if (!entries.includes(required)) {
      errors.push({
        rule: RULE_KEYS.missingFile,
        path: path.join(dir, required),
        message: `missing required file '${required}'`,
      });
    }
  }

  const libPath = path.join(dir, LIBRARY_FILE);
  const metaPath = path.join(dir, META_FILE);

  // Past this point, stop if the library file or meta file is missing.
  const hasLib = existsSync(libPath);
  const hasMeta = existsSync(metaPath);

  // 2. library.scribblylib size + parsing
  let libBuf: Buffer | null = null;
  let lib: ScribblyLib | null = null;
  if (hasLib) {
    const stats = statSync(libPath);
    if (stats.size > maxBytes) {
      errors.push({
        rule: RULE_KEYS.fileTooLarge,
        path: libPath,
        message: `${LIBRARY_FILE} is ${stats.size} bytes (max ${maxBytes})`,
      });
    }
    libBuf = readFileSync(libPath);
    try {
      lib = JSON.parse(libBuf.toString("utf8")) as ScribblyLib;
    } catch (e) {
      errors.push({
        rule: RULE_KEYS.notJson,
        path: libPath,
        message: (e as Error).message,
      });
    }
  }

  // 3. meta.yaml parsing
  let meta: Meta | null = null;
  if (hasMeta) {
    const text = readFileSync(metaPath, "utf8");
    let parsed: unknown = undefined;
    try {
      parsed = parseYaml(text);
    } catch (e) {
      errors.push({
        rule: RULE_KEYS.notYaml,
        path: metaPath,
        message: (e as Error).message,
      });
    }
    // YAML allows null/scalar root documents, but our schema requires an
    // object. Treat anything else as a structural failure so downstream
    // checks (and the manifest builder) don't see null.
    if (parsed !== undefined) {
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        errors.push({
          rule: RULE_KEYS.schemaMeta,
          path: metaPath,
          message: "meta.yaml must be a non-empty YAML object",
        });
      } else {
        meta = parsed as Meta;
      }
    }
  }

  // 4. JSON Schema validation
  const validators = getValidators(schemasDir);
  if (lib !== null) {
    const ok = validators.scribblylib(lib);
    if (!ok) {
      errors.push(
        ...ajvErrorsToValidationErrors(
          validators.scribblylib.errors,
          RULE_KEYS.schemaScribblylib,
          libPath,
        ),
      );
    }
  }
  if (meta !== null) {
    const ok = validators.meta(meta);
    if (!ok) {
      errors.push(
        ...ajvErrorsToValidationErrors(
          validators.meta.errors,
          RULE_KEYS.schemaMeta,
          metaPath,
        ),
      );
    }
  }

  // 5. Cross-field checks on .scribblylib — only attempt if schema passed,
  //    otherwise we'd cascade noise from malformed elements.
  if (lib !== null && validators.scribblylib.errors == null) {
    // (a) ≥ 3 items is also schema-checked, but check here for a clean key.
    if (lib.libraryItems.length < 3) {
      errors.push({
        rule: RULE_KEYS.tooFewItems,
        path: libPath,
        message: `library has ${lib.libraryItems.length} items, need ≥ 3`,
      });
    }
    // (b) Per-item self-containment + non-trivial
    lib.libraryItems.forEach((item, i) => {
      const itemPath = `${libPath}/libraryItems[${i}]`;
      if (isItemTrivial(item)) {
        errors.push({
          rule: RULE_KEYS.trivialItem,
          path: itemPath,
          message: `item '${item.name}' is a single trivial element — needs ≥ 2 elements or a non-trivial single element (text with content, freedraw with > 10 points, etc.)`,
        });
      }
      errors.push(...checkSelfContainment(item, itemPath));
    });
    // (c) English heuristic on every in-item text label
    lib.libraryItems.forEach((item, i) => {
      for (const { text, path: tPath } of collectItemTexts(item, i)) {
        if (!isEnglishish(text)) {
          errors.push({
            rule: RULE_KEYS.nonEnglishTextContent,
            path: `${libPath}/${tPath}`,
            message: `text fails English heuristic (< 90 % basic Latin): ${truncate(text, 40)}`,
          });
        }
      }
    });
  }

  // 6. Cross-field checks on meta.yaml
  if (meta !== null && validators.meta.errors == null) {
    if (!isEnglishish(meta.name)) {
      errors.push({
        rule: RULE_KEYS.nonEnglishMeta,
        path: `${metaPath}/name`,
        message: `meta.name fails English heuristic: ${truncate(meta.name, 40)}`,
      });
    }
    if (!isEnglishish(meta.description)) {
      errors.push({
        rule: RULE_KEYS.nonEnglishMeta,
        path: `${metaPath}/description`,
        message: `meta.description fails English heuristic: ${truncate(meta.description, 60)}`,
      });
    }
    // (d) handle in meta == handle from directory path
    if (meta.author?.handle && meta.author.handle !== handle) {
      errors.push({
        rule: RULE_KEYS.authorMismatch,
        path: `${metaPath}/author.handle`,
        message: `meta.author.handle '${meta.author.handle}' does not match directory '${handle}'`,
      });
    }
    // (e) PR author = directory handle (only when GITHUB_ACTOR is available)
    if (opts.prAuthor && opts.prAuthor.toLowerCase() !== handle) {
      errors.push({
        rule: RULE_KEYS.authorMismatch,
        path: dir,
        message: `PR author '${opts.prAuthor}' does not match submission handle '${handle}'`,
      });
    }
  }

  // 7. Slug history: if the slug previously belonged to a different handle, reject.
  if (opts.previouslyKnownSlugs) {
    const prior = opts.previouslyKnownSlugs.get(slug);
    if (prior && prior !== handle) {
      errors.push({
        rule: RULE_KEYS.slugConflictHistory,
        path: dir,
        message: `slug '${slug}' was previously owned by '${prior}' — cross-handle reuse is blocked to prevent squatting`,
      });
    }
  }

  // 8. Manifest comparison: semver monotonicity + SHA-256 stability.
  if (opts.manifest && meta !== null && lib !== null && libBuf !== null) {
    const priorEntries = opts.manifest.filter((e) => e.slug === fullSlug);
    if (priorEntries.length > 0) {
      const latest = priorEntries.reduce((acc, cur) =>
        compareSemver(cur.version, acc.version) > 0 ? cur : acc,
      );
      const cmp = compareSemver(meta.version, latest.version);
      if (cmp < 0) {
        errors.push({
          rule: RULE_KEYS.versionNotMonotonic,
          path: `${metaPath}/version`,
          message: `version '${meta.version}' is lower than previously published '${latest.version}'`,
        });
      }
      const sameVersion = priorEntries.find((e) => e.version === meta.version);
      if (sameVersion) {
        const currentSha = sha256Hex(libBuf);
        if (sameVersion.sha256 !== currentSha) {
          errors.push({
            rule: RULE_KEYS.shaInstability,
            path: libPath,
            message: `republishing version '${meta.version}' with different bytes (sha256 ${currentSha} ≠ published ${sameVersion.sha256}). Bump meta.version.`,
          });
        }
      }
    }
  }

  return errors.length === 0
    ? { ok: true, slug: fullSlug }
    : { ok: false, slug: fullSlug, errors };
}

// ---------- Multi-submission driver ----------

export function validateAll(
  submissionsRoot: string,
  opts: ValidateOptions = {},
): { ok: boolean; results: ValidationResult[] } {
  const results: ValidationResult[] = [];
  if (!existsSync(submissionsRoot)) {
    return { ok: true, results };
  }
  for (const handle of readdirSync(submissionsRoot)) {
    const handleDir = path.join(submissionsRoot, handle);
    if (!statSync(handleDir).isDirectory()) continue;
    for (const slug of readdirSync(handleDir)) {
      const slugDir = path.join(handleDir, slug);
      if (!statSync(slugDir).isDirectory()) continue;
      results.push(validateSubmission(slugDir, opts));
    }
  }
  return { ok: results.every((r) => r.ok), results };
}

// ---------- Utilities ----------

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function defaultSchemasDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "schemas");
}

function defaultSubmissionsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "submissions");
}

// ---------- CLI ----------

function printReport(results: ValidationResult[]): void {
  for (const r of results) {
    if (r.ok) {
      console.log(`OK   ${r.slug}`);
    } else {
      for (const err of r.errors) {
        console.error(`FAIL ${r.slug} [${err.rule}] ${err.message}`);
        console.error(`       at ${err.path}`);
      }
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const opts: ValidateOptions = {
    prAuthor: process.env["GITHUB_ACTOR"],
  };
  let ok: boolean;
  let results: ValidationResult[];
  if (args.length === 0) {
    const out = validateAll(defaultSubmissionsDir(), opts);
    ok = out.ok;
    results = out.results;
  } else {
    results = args.map((dir) => validateSubmission(path.resolve(dir), opts));
    ok = results.every((r) => r.ok);
  }
  printReport(results);
  if (!ok) {
    console.error(
      `\n${results.filter((r) => !r.ok).length} submission(s) failed validation`,
    );
    process.exit(1);
  }
  console.log(`\n${results.length} submission(s) passed`);
}

const isCliEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  import.meta.url === `file:///${process.argv[1]?.replace(/^\//, "")}`;
if (isCliEntrypoint) {
  main();
}
