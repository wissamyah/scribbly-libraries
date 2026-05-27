/**
 * scripts/intake.ts
 *
 * Workflow-callable companion to scripts/review.ts. Where review.ts is a
 * maintainer-driven CLI for legacy free-form issues, this script is run by
 * the `intake.yml` GitHub Action whenever a new submission issue (created
 * via .github/ISSUE_TEMPLATE/submit-library.yml) is opened.
 *
 *   tsx scripts/intake.ts <issue-number>
 *
 * What it does:
 *  1. `gh issue view <n>` (gh is preinstalled on GitHub-hosted runners and
 *     authenticated via GITHUB_TOKEN exported by the workflow).
 *  2. Parses the body using the Issue Form section markers — `### Library
 *     name`, `### Slug`, `### License`, checkbox list under `### Tags`,
 *     etc. This format is much cleaner than the free-form one because
 *     dropdowns/checkboxes enforce valid values up front, so we don't need
 *     fuzzy parsing.
 *  3. Downloads the attached `.scribblylib.json`.
 *  4. Scaffolds `submissions/<handle>/<slug>/{library.scribblylib,meta.yaml}`.
 *  5. Prints a JSON line to stdout with `{ handle, slug, branch }` so the
 *     workflow can pipe it into git commands without re-parsing.
 *
 * Exit codes:
 *   0 — scaffolded; caller proceeds to open a PR.
 *   2 — submitter error (missing attachment, bad slug). Caller comments on
 *       the issue and stops; no PR.
 *   1 — unexpected error.
 *
 * Why a separate script from review.ts:
 *   Different parsers, different I/O contract (this one is silent except
 *   for the JSON result line), and we don't want to confuse legacy
 *   free-form issues with the new structured ones.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------- gh / fs helpers ----------

type Issue = {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  url: string;
};

function ghIssueView(num: number): Issue {
  const res = spawnSync(
    "gh",
    ["issue", "view", String(num), "--json", "number,title,body,author,url"],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(
      `gh issue view ${num} failed (exit ${res.status}): ${res.stderr}`,
    );
  }
  return JSON.parse(res.stdout) as Issue;
}

function ghIssueComment(num: number, body: string): void {
  const res = spawnSync(
    "gh",
    ["issue", "comment", String(num), "--body", body],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    console.error(`gh issue comment failed: ${res.stderr}`);
  }
}

async function downloadFile(url: string, dest: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `download failed ${res.status} ${res.statusText} for ${url}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.byteLength;
}

// ---------- Issue Form parsing ----------

type Parsed = {
  name: string | null;
  slug: string | null;
  description: string | null;
  license: string | null;
  tags: string[];
  attachmentUrl: string | null;
};

const VALID_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
]);

const VALID_TAGS = new Set([
  "ui",
  "icons",
  "diagrams",
  "flowcharts",
  "mindmaps",
  "charts",
  "infrastructure",
  "software-architecture",
  "web-design",
  "education",
  "annotations",
  "presentations",
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

// Issue Forms render each field as `### <Label>` followed by the value (or
// `_No response_` when the field was left blank — possible only for
// non-required fields, which we don't have).
function splitSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = body.split(/\r?\n/);
  let currentHeader: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (currentHeader !== null) {
      sections.set(currentHeader, buffer.join("\n").trim());
    }
  };
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      flush();
      currentHeader = (m[1] ?? "").trim().toLowerCase();
      buffer = [];
    } else if (currentHeader !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function parseCheckedItems(section: string): string[] {
  const out: string[] = [];
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(/^- \[([xX])\]\s+(.+?)\s*$/);
    if (m) out.push((m[2] ?? "").trim());
  }
  return out;
}

function findAttachmentUrl(section: string): string | null {
  const re =
    /\[([^\]]+\.(?:scribblylib\.json|scribblylib|json))\]\((https?:\/\/[^\s)]+)\)/i;
  const m = section.match(re);
  return m ? (m[2] ?? null) : null;
}

function parseIssueForm(issue: Issue): Parsed {
  const sections = splitSections(issue.body ?? "");
  const name = sections.get("library name") || null;
  const slug = (sections.get("slug") || "").trim().toLowerCase() || null;
  const description = sections.get("description") || null;
  const licenseRaw = (sections.get("license") || "").trim();
  const license = VALID_LICENSES.has(licenseRaw) ? licenseRaw : null;
  const tags = parseCheckedItems(sections.get("tags") || "").filter((t) =>
    VALID_TAGS.has(t),
  );
  const attachmentUrl = findAttachmentUrl(sections.get("library file") || "");
  return { name, slug, description, license, tags, attachmentUrl };
}

// ---------- meta.yaml writer ----------

function yamlEscape(s: string): string {
  if (/^[\w\s.,()'\-:/!?]*$/.test(s) && !/^[#&*!|>%@`]/.test(s) && !/:\s/.test(s)) {
    return s;
  }
  return JSON.stringify(s);
}

function buildMetaYaml(p: Parsed, handle: string): string {
  // All fields are required by the Issue Form, so by the time we get here
  // they're guaranteed non-null. We narrow defensively anyway.
  if (!p.name || !p.description || !p.license || p.tags.length === 0) {
    throw new Error("buildMetaYaml called with incomplete data");
  }
  const tagLines = p.tags.map((t) => `  - ${t}`).join("\n");
  return [
    `name: ${yamlEscape(p.name)}`,
    `description: ${yamlEscape(p.description)}`,
    `version: 1.0.0`,
    `author:`,
    `  handle: ${yamlEscape(handle)}`,
    `license: ${p.license}`,
    `tags:`,
    tagLines,
    ``,
  ].join("\n");
}

// ---------- Orchestration ----------

function repoRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

type IntakeResult = {
  handle: string;
  slug: string;
  branch: string;
  slugDir: string;
};

async function intake(issueNum: number): Promise<IntakeResult> {
  const issue = ghIssueView(issueNum);
  const parsed = parseIssueForm(issue);

  // Bail with a user-facing comment for the cases the Issue Form *can't*
  // catch via dropdowns/checkboxes. Required fields enforced by the form
  // (name, description, license, tags, file) will normally be present, but
  // a malformed slug or missing/unparseable attachment URL still happen.
  const handle = issue.author.login.toLowerCase();
  const errors: string[] = [];
  if (!parsed.slug) {
    errors.push("• **Slug** is missing.");
  } else if (!SLUG_RE.test(parsed.slug)) {
    errors.push(
      `• **Slug** \`${parsed.slug}\` doesn't match \`^[a-z0-9](?:[a-z0-9-]{0,62})$\`. Use lowercase letters, digits, and dashes only.`,
    );
  }
  if (!parsed.attachmentUrl) {
    errors.push(
      "• **Library file** is missing. Drag your `.scribblylib.json` directly into the Library file field.",
    );
  }
  if (!parsed.license) {
    errors.push("• **License** is not one of the allowed values.");
  }
  if (parsed.tags.length === 0) {
    errors.push("• Pick at least one **Tag**.");
  }
  if (errors.length > 0) {
    ghIssueComment(
      issueNum,
      `Thanks for submitting! I can't open a PR yet — please edit this issue and fix:\n\n${errors.join(
        "\n",
      )}\n\nAfter editing, comment \`/retry\` and I'll try again.`,
    );
    process.exit(2);
  }

  const slug = parsed.slug as string;
  const attachmentUrl = parsed.attachmentUrl as string;

  const root = repoRoot();
  const slugDir = path.join(root, "submissions", handle, slug);
  if (existsSync(slugDir)) {
    ghIssueComment(
      issueNum,
      `Can't open a PR: \`submissions/${handle}/${slug}\` already exists. Pick a different slug (or bump the version in your existing library's \`meta.yaml\` via a separate PR).`,
    );
    process.exit(2);
  }
  mkdirSync(slugDir, { recursive: true });

  const libPath = path.join(slugDir, "library.scribblylib");
  const bytes = await downloadFile(attachmentUrl, libPath);

  // Quick sanity-check on the JSON shape. Full validation runs in CI on
  // the resulting PR — this is just to catch "attachment is a screenshot"
  // before we open a PR for it.
  try {
    const parsedLib = JSON.parse(readFileSync(libPath, "utf8")) as {
      type?: string;
    };
    if (parsedLib.type !== "scribblylib") {
      ghIssueComment(
        issueNum,
        `Attachment doesn't look like a Scribbly library file (\`type\` was \`${parsedLib.type ?? "missing"}\`, expected \`scribblylib\`). Re-export from Scribbly and replace the attachment.`,
      );
      process.exit(2);
    }
  } catch (e) {
    ghIssueComment(
      issueNum,
      `Attachment (${bytes} bytes) isn't valid JSON: ${(e as Error).message}. Make sure you dragged the \`.scribblylib.json\` file Scribbly downloaded, not a screenshot or zip.`,
    );
    process.exit(2);
  }

  writeFileSync(
    path.join(slugDir, "meta.yaml"),
    buildMetaYaml(parsed, handle),
    "utf8",
  );

  const branch = `submission/${handle}-${slug}`;
  return { handle, slug, branch, slugDir };
}

// ---------- CLI ----------

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || !/^\d+$/.test(arg)) {
    console.error("usage: intake.ts <issue-number>");
    process.exit(1);
  }
  const issueNum = Number(arg);
  const result = await intake(issueNum);
  // Single line of structured output for the workflow to consume.
  console.log(JSON.stringify(result));
}

main().catch((e) => {
  console.error(`intake failed: ${(e as Error).message}`);
  process.exit(1);
});
