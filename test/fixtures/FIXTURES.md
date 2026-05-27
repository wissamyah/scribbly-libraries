# Validator fixtures

Each subdirectory under `valid/` and `invalid/` is a complete (or near-complete) submission of the form:

```
<fixture>/
├── library.scribblylib
└── meta.yaml
```

— exactly what `validate.ts` consumes when it walks `submissions/<handle>/<slug>/`. Fixtures are seeded from `valid/happy-path/` and mutated to violate a single rule each, so the failure mode is unambiguous.

## Schema-side rules (table from `PLAN.md`, owned by `schemas/*.json`)

| Rule (PLAN) | Fixture(s) | Expected fail point |
|---|---|---|
| File parses as valid JSON | `invalid/01-not-json` | `JSON.parse` throws on `library.scribblylib` |
| Schema match — per-type required fields | `invalid/02-missing-required-corner-radius` | ajv: rectangle missing `cornerRadius` |
| Schema match — `seed` is integer | `invalid/03-non-integer-seed` | ajv: seed = 1.5 fails `type: integer` |
| Schema match — no `image` elements | `invalid/04-image-element` | ajv: `type: image` hits the `if/then: false` branch |
| Schema match — `isDeleted` const false | `invalid/05-isdeleted-true` | ajv: `isDeleted: true` fails `const: false` |
| ≥ 3 items per library | `invalid/06-too-few-items` | ajv: `libraryItems.minItems: 3` |
| `meta.license` in SPDX allowlist | `invalid/13-bad-license` | ajv (meta): license enum |
| `meta.name` ≤ 60 chars | `invalid/14-name-too-long` | ajv (meta): `maxLength: 60` |
| ≤ 8 tags | `invalid/15-too-many-tags` | ajv (meta): `tags.maxItems: 8` |
| Tag in controlled vocabulary | `invalid/16-invalid-tag` | ajv (meta): `tags.items.enum` |
| `meta.author.handle` is a valid GitHub-handle slug | `invalid/17-bad-handle` | ajv (meta): handle pattern |
| `meta.version` is strict semver | `invalid/18-bad-semver` | ajv (meta): version pattern |

## Cross-field rules (table from `PLAN.md`, owned by `validate.ts`)

| Rule (PLAN) | Fixture(s) | Expected fail point |
|---|---|---|
| Self-containedness: `containerId` refers to in-item element | `invalid/08-dangling-container` | validate.ts: `dangling-container` |
| Self-containedness: arrow binding `elementId` refers to in-item element | `invalid/09-dangling-arrow-binding` | validate.ts: `dangling-binding` |
| Self-containedness: `groupId` has ≥ 2 members within the item | `invalid/10-dangling-groupid` | validate.ts: `dangling-groupid` |
| Each item ≥ 2 elements **or** non-trivial single element | `invalid/07-trivial-single-element` | validate.ts: `trivial-item` |
| English text in in-item text labels (CJK) | `invalid/11-non-english-text` | validate.ts: `non-english-text-content` |
| English text in in-item text labels (Cyrillic) | `invalid/21-cyrillic-text` | validate.ts: `non-english-text-content` |
| English text in `meta.description` | `invalid/12-non-english-meta-description` | validate.ts: `non-english-meta` |
| Directory contains only `library.scribblylib` + `meta.yaml` (no strays) | `invalid/19-stray-file` | validate.ts: `unexpected-file` |
| Submission directory contains `meta.yaml` | `invalid/20-missing-meta` | validate.ts: `missing-file: meta.yaml` |

## Happy path

| Fixture | Notes |
|---|---|
| `valid/happy-path` | 3 items: (1) rectangle + bound text (`containerId`), (2) rectangle + arrow with `startBinding`, (3) freedraw with 13 points (non-trivial single element). Exercises self-containment for `containerId`, arrow `startBinding`, and the freedraw-points side of the non-trivial rule. |

## Rules NOT covered by static fixtures

The following rules depend on **runtime state** (filesystem layout outside this fixture, env vars, or comparison against a previously-published artifact) that can't be checked as a static file. They are covered by inline test cases in `test/validate.test.ts` that synthesize the required surroundings via `fs.mkdtempSync` and stub manifests:

| Rule (PLAN) | Where the test belongs |
|---|---|
| `library.scribblylib` ≤ 512 KB | Synthesize a `.scribblylib` with a padded `preview` data URL into a tmpdir; assert reject. |
| Slug `<handle>/<slug>` is unique against existing `submissions/` | Build a tmp `submissions/` tree containing `alice/foo/` and another PR also adding `alice/foo/`; assert reject. |
| Slug uniqueness against git history (handle squatting) | Stub the "git history known slugs" lookup with a fixed Set; assert reject when slug previously belonged to a different handle. |
| PR-author handle matches directory name | Set `GITHUB_ACTOR=other` in the test env and run validate against `submissions/wissam/...`; assert reject. |
| Semver monotonicity vs previously published manifest | Provide a stub manifest with `wissam/server-rack@1.0.0`; submit `version: 0.9.0`; assert reject. |
| SHA-256 stability for same `version` republish | Provide a stub manifest with `wissam/server-rack@1.0.0 + sha256=X`; submit different bytes at the same version; assert reject. |

(The PLAN does not specify whether the "no binary blobs other than preview PNG" rule applies — the schema already rejects `image` elements outright, which is the only place binary blobs would land. No separate dynamic test needed.)

## Conventions

- Fixture directory name encodes its purpose; never depended on by code outside the test runner.
- All fixtures share the same seeded UUIDs from `valid/happy-path` so cross-fixture diffs are minimal and readable.
- `invalid/` fixtures violate **one** rule each. If a mutation accidentally violates additional rules (e.g. removing `cornerRadius` also fails self-containment? — no, it doesn't, but worth checking on each edit), the test asserts on the **first** error the validator emits.
