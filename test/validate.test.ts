/**
 * Tests for scripts/validate.ts.
 *
 * Two test groups:
 *   1. Static fixtures under test/fixtures/{valid,invalid}/<name>/. Each
 *      invalid fixture is mutated to break exactly one rule; the assertion
 *      is that the validator's error set contains the expected rule key.
 *   2. Dynamic cases that can't be expressed as a static fixture (file
 *      size, slug history, PR-author, semver monotonicity, SHA stability)
 *      — these synthesize the required surroundings in tmpdirs.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  RULE_KEYS,
  type RuleKey,
  type ManifestEntry,
  type ValidationResult,
  isEnglishish,
  isItemTrivial,
  compareSemver,
  sha256Hex,
  validateSubmission,
} from "../scripts/validate.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesRoot = path.resolve(here, "fixtures");
const happyPath = path.join(fixturesRoot, "valid", "happy-path");

function rulesIn(result: ValidationResult): RuleKey[] {
  return result.ok ? [] : result.errors.map((e) => e.rule);
}

// ---------- Pure helpers ----------

describe("isEnglishish", () => {
  it("accepts plain English", () => {
    expect(isEnglishish("Datacenter rack units.")).toBe(true);
  });
  it("rejects CJK", () => {
    expect(isEnglishish("数据中心机架")).toBe(false);
  });
  it("rejects Cyrillic", () => {
    expect(isEnglishish("Сервер")).toBe(false);
  });
  it("accepts text with a single non-Latin character among lots of Latin", () => {
    expect(isEnglishish("This is mostly English, one é, the rest ascii")).toBe(
      true,
    );
  });
  it("accepts empty string", () => {
    expect(isEnglishish("")).toBe(true);
  });
});

describe("isItemTrivial", () => {
  const base = {
    id: "x",
    type: "rectangle",
    groupId: null,
    frameId: null,
  } as const;
  it("treats a single rectangle as trivial", () => {
    expect(isItemTrivial({ id: "i", name: "n", elements: [{ ...base }] })).toBe(
      true,
    );
  });
  it("treats two rectangles as non-trivial", () => {
    expect(
      isItemTrivial({
        id: "i",
        name: "n",
        elements: [{ ...base, id: "a" }, { ...base, id: "b" }],
      }),
    ).toBe(false);
  });
  it("treats a single freedraw with 13 points as non-trivial", () => {
    expect(
      isItemTrivial({
        id: "i",
        name: "n",
        elements: [
          {
            id: "a",
            type: "freedraw",
            points: Array.from({ length: 13 }, (_, i) => [i, 0] as const),
          },
        ],
      }),
    ).toBe(false);
  });
  it("treats an empty-text text element as trivial", () => {
    expect(
      isItemTrivial({
        id: "i",
        name: "n",
        elements: [{ id: "a", type: "text", text: "   " }],
      }),
    ).toBe(true);
  });
});

describe("compareSemver", () => {
  it("orders patches", () => {
    expect(compareSemver("1.0.1", "1.0.0")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
  });
  it("orders minors above patches", () => {
    expect(compareSemver("1.1.0", "1.0.99")).toBe(1);
  });
  it("returns 0 for equal versions", () => {
    expect(compareSemver("2.3.4", "2.3.4")).toBe(0);
  });
});

// ---------- Happy path ----------

describe("validateSubmission — happy path", () => {
  it("accepts valid/happy-path with no errors", () => {
    const result = validateSubmission(happyPath);
    if (!result.ok) {
      console.error(result.errors);
    }
    expect(result.ok).toBe(true);
  });
});

// ---------- Static invalid fixtures ----------

const invalidCases: Array<{ dir: string; expected: RuleKey }> = [
  { dir: "01-not-json", expected: RULE_KEYS.notJson },
  {
    dir: "02-missing-required-corner-radius",
    expected: RULE_KEYS.schemaScribblylib,
  },
  { dir: "03-non-integer-seed", expected: RULE_KEYS.schemaScribblylib },
  { dir: "04-image-element", expected: RULE_KEYS.schemaScribblylib },
  { dir: "05-isdeleted-true", expected: RULE_KEYS.schemaScribblylib },
  { dir: "06-too-few-items", expected: RULE_KEYS.schemaScribblylib },
  { dir: "07-trivial-single-element", expected: RULE_KEYS.trivialItem },
  { dir: "08-dangling-container", expected: RULE_KEYS.danglingContainer },
  { dir: "09-dangling-arrow-binding", expected: RULE_KEYS.danglingBinding },
  { dir: "10-dangling-groupid", expected: RULE_KEYS.danglingGroupId },
  { dir: "11-non-english-text", expected: RULE_KEYS.nonEnglishTextContent },
  {
    dir: "12-non-english-meta-description",
    expected: RULE_KEYS.nonEnglishMeta,
  },
  { dir: "13-bad-license", expected: RULE_KEYS.schemaMeta },
  { dir: "14-name-too-long", expected: RULE_KEYS.schemaMeta },
  { dir: "15-too-many-tags", expected: RULE_KEYS.schemaMeta },
  { dir: "16-invalid-tag", expected: RULE_KEYS.schemaMeta },
  { dir: "17-bad-handle", expected: RULE_KEYS.schemaMeta },
  { dir: "18-bad-semver", expected: RULE_KEYS.schemaMeta },
  { dir: "19-stray-file", expected: RULE_KEYS.unexpectedFile },
  { dir: "20-missing-meta", expected: RULE_KEYS.missingFile },
  { dir: "21-cyrillic-text", expected: RULE_KEYS.nonEnglishTextContent },
];

describe("validateSubmission — static invalid fixtures", () => {
  for (const { dir, expected } of invalidCases) {
    it(`${dir} → ${expected}`, () => {
      const fixturePath = path.join(fixturesRoot, "invalid", dir);
      const result = validateSubmission(fixturePath);
      expect(result.ok).toBe(false);
      expect(rulesIn(result)).toContain(expected);
    });
  }
});

// ---------- Dynamic fixtures synthesized in tmpdirs ----------

function makeTmpSubmission(handle: string, slug: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "scribbly-libraries-"));
  const dir = path.join(root, "submissions", handle, slug);
  mkdirSync(dir, { recursive: true });
  copyFileSync(
    path.join(happyPath, "library.scribblylib"),
    path.join(dir, "library.scribblylib"),
  );
  copyFileSync(
    path.join(happyPath, "meta.yaml"),
    path.join(dir, "meta.yaml"),
  );
  // Happy-path meta has handle "valid". Realign to the actual handle.
  const metaPath = path.join(dir, "meta.yaml");
  const original = readFileSync(metaPath, "utf8");
  writeFileSync(metaPath, original.replace(/handle: \w+/, `handle: ${handle}`));
  return dir;
}

function cleanup(dir: string): void {
  // dir is .../submissions/handle/slug → step up to the mkdtemp root.
  const root = path.resolve(dir, "..", "..", "..");
  rmSync(root, { recursive: true, force: true });
}

describe("validateSubmission — dynamic rules", () => {
  it("rejects when library.scribblylib exceeds the size budget", () => {
    const dir = makeTmpSubmission("wissam", "fat-pack");
    try {
      const big = "x".repeat(600 * 1024);
      writeFileSync(path.join(dir, "library.scribblylib"), big);
      const result = validateSubmission(dir);
      expect(rulesIn(result)).toContain(RULE_KEYS.fileTooLarge);
    } finally {
      cleanup(dir);
    }
  });

  it("rejects when PR author does not match the submission handle", () => {
    const dir = makeTmpSubmission("wissam", "ok-pack");
    try {
      const result = validateSubmission(dir, { prAuthor: "someone-else" });
      expect(rulesIn(result)).toContain(RULE_KEYS.authorMismatch);
    } finally {
      cleanup(dir);
    }
  });

  it("accepts when PR author matches", () => {
    const dir = makeTmpSubmission("wissam", "ok-pack");
    try {
      const result = validateSubmission(dir, { prAuthor: "wissam" });
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("rejects when the slug was previously owned by a different handle", () => {
    const dir = makeTmpSubmission("alice", "shared-slug");
    try {
      const result = validateSubmission(dir, {
        previouslyKnownSlugs: new Map([["shared-slug", "bob"]]),
      });
      expect(rulesIn(result)).toContain(RULE_KEYS.slugConflictHistory);
    } finally {
      cleanup(dir);
    }
  });

  it("accepts when the same handle re-publishes its own slug", () => {
    const dir = makeTmpSubmission("alice", "owned-slug");
    try {
      const result = validateSubmission(dir, {
        previouslyKnownSlugs: new Map([["owned-slug", "alice"]]),
      });
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("rejects a version regression against the published manifest", () => {
    const dir = makeTmpSubmission("wissam", "rack");
    try {
      const metaPath = path.join(dir, "meta.yaml");
      const original = readFileSync(metaPath, "utf8");
      writeFileSync(metaPath, original.replace("version: 1.0.0", "version: 0.9.0"));
      const manifest: ManifestEntry[] = [
        { slug: "wissam/rack", version: "1.0.0", sha256: "deadbeef" },
      ];
      const result = validateSubmission(dir, { manifest });
      expect(rulesIn(result)).toContain(RULE_KEYS.versionNotMonotonic);
    } finally {
      cleanup(dir);
    }
  });

  it("accepts a version bump against the published manifest", () => {
    const dir = makeTmpSubmission("wissam", "rack");
    try {
      const metaPath = path.join(dir, "meta.yaml");
      const original = readFileSync(metaPath, "utf8");
      writeFileSync(metaPath, original.replace("version: 1.0.0", "version: 1.1.0"));
      const manifest: ManifestEntry[] = [
        { slug: "wissam/rack", version: "1.0.0", sha256: "deadbeef" },
      ];
      const result = validateSubmission(dir, { manifest });
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });

  it("rejects republishing the same version with different bytes", () => {
    const dir = makeTmpSubmission("wissam", "rack");
    try {
      // current bytes have some sha; manifest claims a *different* sha at
      // the *same* version → SHA-stability rule fires.
      const manifest: ManifestEntry[] = [
        {
          slug: "wissam/rack",
          version: "1.0.0",
          sha256: "0".repeat(64),
        },
      ];
      const result = validateSubmission(dir, { manifest });
      expect(rulesIn(result)).toContain(RULE_KEYS.shaInstability);
    } finally {
      cleanup(dir);
    }
  });

  it("accepts republishing the same version with the same bytes", () => {
    const dir = makeTmpSubmission("wissam", "rack");
    try {
      const buf = readFileSync(path.join(dir, "library.scribblylib"));
      const sha = sha256Hex(buf);
      const manifest: ManifestEntry[] = [
        { slug: "wissam/rack", version: "1.0.0", sha256: sha },
      ];
      const result = validateSubmission(dir, { manifest });
      expect(result.ok).toBe(true);
    } finally {
      cleanup(dir);
    }
  });
});
