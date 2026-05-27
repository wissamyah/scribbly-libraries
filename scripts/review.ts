/**
 * scripts/review.ts
 *
 * Maintainer helper: turn a GitHub "submission" issue from the in-app
 * Scribbly submit flow into a properly-scaffolded PR-ready folder.
 *
 *   npm run review -- <issue-number>            # scaffold + validate locally
 *   npm run review -- <issue-number> --auto-pr  # also create branch + PR
 *
 * What it does:
 *  1. Calls `gh issue view <n> --json ...` to fetch the issue.
 *  2. Parses the body (fields prefilled by the app: name, suggested slug,
 *     license, tags, description, item count).
 *  3. Finds the .scribblylib/.scribblylib.json/.json attachment URL in the
 *     body and downloads it.
 *  4. Creates submissions/<handle>/<slug>/{library.scribblylib,meta.yaml}.
 *  5. Runs the existing validator (validate.ts) against the new folder.
 *  6. With --auto-pr: git checkout -b, commit, gh pr create --fill.
 *
 * Requires: `gh` CLI authenticated (gh auth login).
 *
 * The goal is to compress "30 min of copy-paste per submission" into a
 * single command. Anywhere the issue body is incomplete, the script writes
 * `# TODO: …` markers in meta.yaml and prints a warning, but never blocks
 * you from editing the file yourself before committing.
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

// ---------- gh helpers ----------

type Issue = {
  number: number;
  title: string;
  body: string;
  author: { login: string };
  url: string;
  state: string;
};

function ghIssueView(num: number): Issue {
  const res = spawnSync(
    "gh",
    [
      "issue",
      "view",
      String(num),
      "--json",
      "number,title,body,author,url,state",
    ],
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
    console.warn(`(could not post comment on issue #${num}: ${res.stderr})`);
  }
}

async function downloadFile(url: string, dest: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`download failed ${res.status} ${res.statusText} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf.byteLength;
}

// ---------- Issue body parsing ----------

type Parsed = {
  name: string | null;
  slug: string | null;
  license: string | null;
  authorHandle: string | null;
  description: string | null;
  tags: string[];
  itemCount: number | null;
  attachmentUrl: string | null;
};

const VALID_LICENSES = [
  "MIT",
  "Apache-2.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
];

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

// Strip HTML comments so leftover `<!-- placeholder -->` text from the
// in-app form template doesn't end up in our parsed values.
function stripComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function findLineValue(body: string, label: string): string | null {
  const re = new RegExp(`\\*\\*${escapeRegex(label)}:\\*\\*\\s*(.+)`, "i");
  const m = body.match(re);
  if (!m) return null;
  const v = stripComments(m[1] ?? "").trim();
  return v.length > 0 ? v : null;
}

function findSection(body: string, header: string): string | null {
  // Sections are delimited by `**Header**` on its own line. Grab everything
  // up to the next `**…**` heading or end-of-body.
  const re = new RegExp(
    `\\*\\*${escapeRegex(header)}\\*\\*\\s*\\n([\\s\\S]*?)(?=\\n\\*\\*[^*]+\\*\\*|$)`,
    "i",
  );
  const m = body.match(re);
  if (!m) return null;
  const v = stripComments(m[1] ?? "").trim();
  return v.length > 0 ? v : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Match GitHub user-attachment URLs. Modern uploads land on
// github.com/user-attachments/files/... or user-attachments.githubusercontent.com/...;
// markdown is `[name.json](https://github.com/user-attachments/files/123/name.json)`.
function findAttachmentUrl(body: string): string | null {
  const re =
    /\[([^\]]+\.(?:scribblylib|scribblylib\.json|json))\]\((https?:\/\/[^\s)]+)\)/i;
  const m = body.match(re);
  return m ? (m[2] ?? null) : null;
}

function slugify(input: string): string {
  // Handles two shapes of input:
  //   raw filename : "Geometrical-Shapes.scribblylib (1).json"
  //   pre-slugged  : "geometrical-shapes-scribblylib-1-json"
  // Both should normalize to "geometrical-shapes".
  let out = input.toLowerCase().trim();
  // Strip browser-added duplicate-download suffix " (1)".
  out = out.replace(/\s*\(\d+\)\s*/g, " ");
  // Normalize all separators to '-' so the trailing-extension stripper
  // below can ignore the difference between dots, spaces, and dashes.
  out = out.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Iteratively strip trailing extension noise: "-scribblylib(-N)?" or
  // "-json", optionally repeated (handles "-scribblylib-1-json").
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out
      .replace(/-(?:scribblylib|scribbly|json)(?:-\d+)?$/g, "")
      .replace(/-+$/g, "");
  }
  return (out || "my-library").slice(0, 64);
}

function parseBody(issue: Issue): Parsed {
  const body = issue.body ?? "";
  const name = findLineValue(body, "Library name");
  const slugRaw = findLineValue(body, "Suggested slug");
  // Submitters often wrap the slug in backticks (we even prefilled it that
  // way). Strip them before normalizing.
  const slug = slugRaw ? slugify(slugRaw.replace(/`/g, "")) : null;
  const licenseRaw = findLineValue(body, "License");
  const license =
    licenseRaw && VALID_LICENSES.includes(licenseRaw) ? licenseRaw : null;
  const authorRaw =
    findLineValue(body, "Author handle") ?? issue.author.login;
  const authorHandle = authorRaw
    ? authorRaw.replace(/^@/, "").toLowerCase().trim()
    : null;
  const description = findSection(body, "Description");
  const tagsRaw = findSection(body, "Tags") ?? "";
  const tags = tagsRaw
    .split(/[,\n]/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0 && VALID_TAGS.has(t));
  const itemCountRaw = findLineValue(body, "Item count");
  const itemCount = itemCountRaw ? Number(itemCountRaw) : null;
  const attachmentUrl = findAttachmentUrl(body);

  return {
    name,
    slug,
    license,
    authorHandle,
    description,
    tags,
    itemCount: Number.isFinite(itemCount) ? itemCount : null,
    attachmentUrl,
  };
}

// ---------- meta.yaml writer ----------

function yamlEscape(s: string): string {
  // Quote when the value would be ambiguous to a YAML parser.
  if (/^[\w\s.,()'\-:/!?]*$/.test(s) && !/^[#&*!|>%@`]/.test(s) && !/:\s/.test(s)) {
    return s;
  }
  return JSON.stringify(s);
}

function buildMetaYaml(p: Parsed): string {
  const name = p.name ?? "# TODO: human-readable library name";
  const description = p.description ?? "# TODO: 20–280 chars describing what's in this library";
  const license = p.license ?? "# TODO: pick one of MIT, Apache-2.0, CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0";
  const handle = p.authorHandle ?? "# TODO: github handle (lowercased)";

  const tagLines =
    p.tags.length > 0
      ? p.tags.map((t) => `  - ${t}`).join("\n")
      : "  # TODO: 1–8 tags from the controlled vocabulary in schemas/meta.schema.json";

  return [
    `name: ${yamlEscape(name)}`,
    `description: ${yamlEscape(description)}`,
    `version: 1.0.0`,
    `author:`,
    `  handle: ${yamlEscape(handle)}`,
    `license: ${license}`,
    `tags:`,
    tagLines,
    ``,
  ].join("\n");
}

// ---------- scaffolding ----------

function repoRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

async function scaffoldSubmission(
  parsed: Parsed,
  attachmentUrl: string,
  opts: { force: boolean },
): Promise<{ slugDir: string; warnings: string[] }> {
  const warnings: string[] = [];
  if (!parsed.authorHandle) {
    throw new Error(
      "no author handle found — issue author login was empty and body had no `**Author handle:**` line",
    );
  }
  if (!parsed.slug) {
    throw new Error(
      "no slug found — issue body needs a `**Suggested slug:**` line",
    );
  }

  const root = repoRoot();
  const slugDir = path.join(
    root,
    "submissions",
    parsed.authorHandle,
    parsed.slug,
  );

  if (existsSync(slugDir) && !opts.force) {
    throw new Error(
      `${path.relative(root, slugDir)} already exists. Re-run with --force to overwrite, or pick a different slug.`,
    );
  }
  mkdirSync(slugDir, { recursive: true });

  const libPath = path.join(slugDir, "library.scribblylib");
  const bytes = await downloadFile(attachmentUrl, libPath);

  // Sanity-check: parse it as JSON so we fail loudly here, not later in
  // validate.ts (where the error is less actionable).
  try {
    const parsedLib = JSON.parse(readFileSync(libPath, "utf8")) as {
      type?: string;
      libraryItems?: unknown[];
    };
    if (parsedLib.type !== "scribblylib") {
      warnings.push(
        `attachment's "type" field is "${parsedLib.type}" (expected "scribblylib")`,
      );
    }
    const realCount = Array.isArray(parsedLib.libraryItems)
      ? parsedLib.libraryItems.length
      : 0;
    if (parsed.itemCount !== null && parsed.itemCount !== realCount) {
      warnings.push(
        `submitter claimed ${parsed.itemCount} items but file contains ${realCount}`,
      );
    }
  } catch (e) {
    throw new Error(
      `attachment is not valid JSON: ${(e as Error).message}. Downloaded ${bytes} bytes to ${libPath}.`,
    );
  }

  writeFileSync(path.join(slugDir, "meta.yaml"), buildMetaYaml(parsed), "utf8");

  return { slugDir, warnings };
}

// ---------- validation + git ----------

function runValidator(slugDir: string): { ok: boolean; output: string } {
  // validate.ts accepts positional submission paths — no flags. Pass just
  // the directory we scaffolded so we don't re-validate every other
  // submission in the repo.
  const root = repoRoot();
  const res = spawnSync(
    "npx",
    ["tsx", "scripts/validate.ts", slugDir],
    { cwd: root, encoding: "utf8" },
  );
  const output = (res.stdout ?? "") + (res.stderr ?? "");
  if (res.status === null) {
    return { ok: false, output: `validator did not run: ${res.error?.message}` };
  }
  return { ok: res.status === 0, output };
}

function runGit(args: string[]): { ok: boolean; output: string } {
  const res = spawnSync("git", args, {
    cwd: repoRoot(),
    encoding: "utf8",
  });
  return {
    ok: res.status === 0,
    output: (res.stdout ?? "") + (res.stderr ?? ""),
  };
}

function runGh(args: string[]): { ok: boolean; output: string } {
  const res = spawnSync("gh", args, {
    cwd: repoRoot(),
    encoding: "utf8",
  });
  return {
    ok: res.status === 0,
    output: (res.stdout ?? "") + (res.stderr ?? ""),
  };
}

function autoPr(
  parsed: Parsed,
  slugDir: string,
  issueNum: number,
): { ok: boolean; output: string } {
  const branch = `submission/${parsed.authorHandle}-${parsed.slug}`;
  const relDir = path.relative(repoRoot(), slugDir);
  const title = `Add ${parsed.authorHandle}/${parsed.slug}`;
  const body = `Imports submission from #${issueNum}.\n\nCloses #${issueNum}.\n`;

  const steps: Array<{ label: string; run: () => { ok: boolean; output: string } }> = [
    { label: "git checkout -b", run: () => runGit(["checkout", "-b", branch]) },
    { label: "git add", run: () => runGit(["add", relDir]) },
    {
      label: "git commit",
      run: () => runGit(["commit", "-m", title]),
    },
    {
      label: "git push",
      run: () => runGit(["push", "-u", "origin", branch]),
    },
    {
      label: "gh pr create",
      run: () =>
        runGh(["pr", "create", "--title", title, "--body", body, "--fill"]),
    },
  ];
  for (const s of steps) {
    const r = s.run();
    if (!r.ok) {
      return { ok: false, output: `[${s.label}]\n${r.output}` };
    }
  }
  return { ok: true, output: "" };
}

// ---------- CLI ----------

type Args = {
  issueNum: number;
  autoPr: boolean;
  force: boolean;
  comment: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { issueNum: 0, autoPr: false, force: false, comment: false };
  for (const a of argv) {
    if (a === "--auto-pr") args.autoPr = true;
    else if (a === "--force") args.force = true;
    else if (a === "--comment") args.comment = true;
    else if (/^\d+$/.test(a)) args.issueNum = Number(a);
    else throw new Error(`unknown arg: ${a}`);
  }
  if (args.issueNum === 0) {
    throw new Error("usage: review.ts <issue-number> [--auto-pr] [--force] [--comment]");
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const issue = ghIssueView(args.issueNum);
  console.log(`Fetched issue #${issue.number}: "${issue.title}"`);
  console.log(`  Author : @${issue.author.login}`);
  console.log(`  URL    : ${issue.url}`);
  console.log(`  State  : ${issue.state}`);

  const parsed = parseBody(issue);
  console.log(`\nParsed:`);
  console.log(`  name        : ${parsed.name ?? "(missing)"}`);
  console.log(`  slug        : ${parsed.slug ?? "(missing)"}`);
  console.log(`  license     : ${parsed.license ?? "(missing)"}`);
  console.log(`  handle      : ${parsed.authorHandle ?? "(missing)"}`);
  console.log(`  tags        : ${parsed.tags.length > 0 ? parsed.tags.join(", ") : "(missing)"}`);
  console.log(`  item count  : ${parsed.itemCount ?? "(missing)"}`);
  console.log(`  attachment  : ${parsed.attachmentUrl ?? "(missing)"}`);

  if (!parsed.attachmentUrl) {
    console.error(
      `\nNo attachment URL found in issue body. The submitter forgot to drag the .scribblylib.json file into the issue.`,
    );
    if (args.comment) {
      ghIssueComment(
        args.issueNum,
        "Hey — I don't see a `.scribblylib.json` file attached to this issue. Could you drag the file Scribbly downloaded for you into the issue body and submit again? Without the file we can't review the submission.",
      );
      console.log("Posted a reminder comment on the issue.");
    }
    process.exit(2);
  }

  const { slugDir, warnings } = await scaffoldSubmission(
    parsed,
    parsed.attachmentUrl,
    { force: args.force },
  );
  console.log(`\nScaffolded:`);
  console.log(`  ${path.relative(repoRoot(), slugDir)}/library.scribblylib`);
  console.log(`  ${path.relative(repoRoot(), slugDir)}/meta.yaml`);
  for (const w of warnings) console.warn(`  ⚠ ${w}`);

  console.log(`\nRunning validator…`);
  const v = runValidator(slugDir);
  console.log(v.output.trim());
  if (!v.ok) {
    console.error(
      `\nValidator failed. Inspect the output above, fix meta.yaml (or reject the submission), then re-run.`,
    );
    process.exit(1);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Preview in Scribbly: open the app, Library → Import, pick`);
  console.log(`     ${path.relative(repoRoot(), slugDir)}/library.scribblylib`);
  console.log(`     Inspect each item — wrong content, low quality, bad attribution → reject.`);
  if (args.autoPr) {
    console.log(`\nCreating branch + PR (--auto-pr)…`);
    const pr = autoPr(parsed, slugDir, issue.number);
    if (!pr.ok) {
      console.error(`\nauto-pr failed:\n${pr.output}`);
      process.exit(1);
    }
    console.log(`PR opened. Review locally, then merge on GitHub.`);
  } else {
    console.log(`  2. If good, commit:`);
    console.log(
      `       git checkout -b submission/${parsed.authorHandle}-${parsed.slug}`,
    );
    console.log(
      `       git add ${path.relative(repoRoot(), slugDir)}`,
    );
    console.log(`       git commit -m "Add ${parsed.authorHandle}/${parsed.slug}"`);
    console.log(`       gh pr create --fill`);
    console.log(`     (or re-run with --auto-pr to do this for you)`);
  }
  console.log(`  3. After the PR merges, close issue #${issue.number} with a thank-you.`);
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
});
