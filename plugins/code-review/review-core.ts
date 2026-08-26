// Pure logic for the Code Review plugin: the findings contract the agent
// writes, the prompt that asks for it, PR filtering, and unified-patch
// splitting. Nothing here touches bb, gh, or the filesystem, so it is all
// unit-testable without a server.
import { z } from "zod";

// ---------------------------------------------------------------------------
// The findings contract
// ---------------------------------------------------------------------------

export const SEVERITIES = ["blocker", "high", "medium", "low", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Rank for sorting: lower sorts first. */
export function severityRank(severity: string): number {
  const index = (SEVERITIES as readonly string[]).indexOf(severity);
  return index === -1 ? SEVERITIES.length : index;
}

export const findingSchema = z.object({
  /** Repo-relative path of the file the finding is about. */
  file: z.string().trim().min(1),
  /** First line of the affected range, in the PR's new file. */
  startLine: z.number().int().positive().nullable(),
  /** Last line of the affected range; equals startLine for a single line. */
  endLine: z.number().int().positive().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  severity: z.enum(SEVERITIES),
  category: z.string().trim(),
  title: z.string().trim().min(1),
  /** What the code is doing — the context needed to understand the issue. */
  background: z.string().trim(),
  /** What is actually wrong. */
  problem: z.string().trim().min(1),
  suggestedFix: z.string().trim(),
  /** Ready-to-post review comment text. */
  suggestedComment: z.string().trim().min(1),
});
export type Finding = z.infer<typeof findingSchema>;

export const reportSchema = z.object({
  summary: z.string().trim(),
  findings: z.array(findingSchema),
});
export type Report = z.infer<typeof reportSchema>;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(row: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = str(row[key]);
    if (value !== "") return value;
  }
  return "";
}

function firstLine(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isInteger(value) && value > 0) {
      return value;
    }
    // Models sometimes emit "42" or "42-48"; take the leading integer.
    if (typeof value === "string") {
      const match = value.trim().match(/^(\d+)/);
      if (match !== null) {
        const parsed = Number(match[1]);
        if (parsed > 0) return parsed;
      }
    }
  }
  return null;
}

/**
 * Coerce one agent-written finding into the strict shape. Agents reliably
 * produce the right *fields* and unreliably produce the right *spelling* of
 * them, so accept the common aliases rather than failing a whole report over
 * `snake_case`. Anything still missing fails validation below.
 */
export function normalizeFinding(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return input;
  }
  const row = input as Record<string, unknown>;
  const start = firstLine(row, ["startLine", "start_line", "line", "lineStart"]);
  const end = firstLine(row, ["endLine", "end_line", "lineEnd", "line"]);
  const side = firstString(row, ["side"]).toUpperCase();
  const severity = firstString(row, ["severity", "priority"]).toLowerCase();
  return {
    file: firstString(row, ["file", "path", "filename"]),
    startLine: start,
    // A range that reads backwards is a model slip, not a range.
    endLine: end !== null && start !== null && end < start ? start : end,
    side: side === "LEFT" ? "LEFT" : "RIGHT",
    severity: (SEVERITIES as readonly string[]).includes(severity)
      ? severity
      : "medium",
    category: firstString(row, ["category", "kind", "type"]),
    title: firstString(row, ["title", "summary", "headline"]),
    background: firstString(row, ["background", "context"]),
    problem: firstString(row, ["problem", "issue", "description", "detail"]),
    suggestedFix: firstString(row, ["suggestedFix", "suggested_fix", "fix"]),
    suggestedComment: firstString(row, [
      "suggestedComment",
      "suggested_comment",
      "comment",
    ]),
  };
}

export interface ParsedReport {
  report: Report | null;
  /** Human-readable reasons individual findings or the whole file were rejected. */
  errors: string[];
}

/**
 * Parse the JSON file the agent wrote. A single malformed finding is dropped
 * with an explanation rather than discarding the rest of the review — a
 * review that surfaces four of five findings beats one that surfaces none.
 */
export function parseReport(raw: string): ParsedReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      report: null,
      errors: [`not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }
  // Accept a bare array of findings as well as the documented envelope.
  const envelope: Record<string, unknown> = Array.isArray(parsed)
    ? { findings: parsed }
    : typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  const rawFindings = envelope.findings ?? envelope.issues ?? envelope.comments;
  if (!Array.isArray(rawFindings)) {
    return {
      report: null,
      errors: ['expected an object with a "findings" array, or a bare array of findings'],
    };
  }
  const errors: string[] = [];
  const findings: Finding[] = [];
  rawFindings.forEach((entry, index) => {
    const result = findingSchema.safeParse(normalizeFinding(entry));
    if (result.success) {
      findings.push(result.data);
    } else {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      errors.push(`finding ${index + 1} dropped — ${detail}`);
    }
  });
  return {
    report: { summary: str(envelope.summary), findings },
    errors,
  };
}

/** The schema text embedded in the prompt and printed by `bb code-review schema`. */
export const FINDINGS_SCHEMA_TEXT = `{
  "summary": "one paragraph on the change overall",
  "findings": [
    {
      "file": "src/server/auth.ts",       // repo-relative path
      "startLine": 42,                     // first affected line in the NEW file (null if none)
      "endLine": 45,                       // last affected line; same as startLine for one line
      "side": "RIGHT",                     // RIGHT = the new file, LEFT = the old file
      "severity": "blocker|high|medium|low|nit",
      "category": "correctness",           // free-form, e.g. correctness, security, tests, naming
      "title": "Session token is compared non-constant-time",
      "background": "What this code does and the context a reader needs.",
      "problem": "What is actually wrong, and why it matters.",
      "suggestedFix": "How you would fix it.",
      "suggestedComment": "The exact review comment text to post on the PR."
    }
  ]
}`;

// ---------------------------------------------------------------------------
// The review prompt
// ---------------------------------------------------------------------------

export interface ReviewPromptArgs {
  repo: string;
  number: number;
  title: string;
  reviewId: string;
  findingsPath: string;
  /** Skill names to invoke, in order. */
  skills: string[];
  /** Free-form extra instructions from plugin settings. */
  extraInstructions: string;
  /** Head commit the fetched diff is pinned to. */
  headSha: string;
}

export function buildReviewPrompt(args: ReviewPromptArgs): string {
  const ref = `${args.repo}#${args.number}`;
  const skillStep =
    args.skills.length === 0
      ? "Review the change for correctness bugs, missing tests, security issues, and design problems."
      : [
          "Run each of these reviews, in order, and merge what they find:",
          ...args.skills.map((skill) => `  - the \`${skill}\` skill`),
        ].join("\n");
  return [
    `Review GitHub pull request ${ref} — ${args.title}`,
    "",
    "## 1. Read the change",
    "",
    "The plugin has already fetched everything from GitHub, so you do NOT need `gh`",
    "and you do NOT need network access. Read it with:",
    "",
    `    bb code-review context --review ${args.reviewId}`,
    `    bb code-review diff --review ${args.reviewId}`,
    "",
    `The diff is pinned to the head commit the review started from (${args.headSha.slice(0, 12)}),`,
    "so its line numbers are the ones your findings should use. If the diff is too",
    "large to print at once, `diff` says so and lists the files; read them one at a",
    `time with \`bb code-review diff --review ${args.reviewId} --file <path>\`.`,
    "",
    "Read the surrounding code in the checkout too — a diff alone rarely shows whether",
    "a change is correct.",
    "",
    "## 2. Review it",
    "",
    skillStep,
    args.extraInstructions.trim() === "" ? null : `\n${args.extraInstructions.trim()}`,
    "",
    "Only report findings you have actually verified against the code. Skip anything",
    "you cannot point at a specific file and line for.",
    "",
    "## 3. Write the findings file",
    "",
    `Write your findings as JSON to \`${args.findingsPath}\` (create parent directories`,
    "if needed), matching this schema exactly:",
    "",
    "```json",
    FINDINGS_SCHEMA_TEXT,
    "```",
    "",
    "`suggestedComment` is posted verbatim to GitHub, so write it as a review comment",
    "addressed to the PR author — not as a note to yourself. Keep it specific and short.",
    "",
    "## 4. Submit them",
    "",
    `    bb code-review submit --review ${args.reviewId} --file ${args.findingsPath}`,
    "",
    "That imports the findings into the Code Review panel and is the last step.",
    "",
    "## Rules",
    "",
    "- Do NOT post anything to GitHub, approve, or request changes. Each comment is",
    "  reviewed and posted by hand from the Code Review panel.",
    "- Do NOT modify the PR, push commits, or edit files in the checkout.",
    "- If you find nothing, still submit a file with an empty `findings` array.",
  ]
    // Only the conditional lines above are dropped; the literal blank strings
    // are the paragraph breaks that make this render as Markdown.
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildDiscussionPrompt(args: {
  repo: string;
  number: number;
  prTitle: string;
  finding: {
    file: string;
    startLine: number | null;
    endLine: number | null;
    title: string;
    background: string;
    problem: string;
    suggestedFix: string;
    suggestedComment: string;
  };
}): string {
  const { finding } = args;
  const location =
    finding.startLine === null
      ? finding.file
      : finding.endLine !== null && finding.endLine !== finding.startLine
        ? `${finding.file}:${finding.startLine}-${finding.endLine}`
        : `${finding.file}:${finding.startLine}`;
  return [
    `I am reviewing GitHub pull request ${args.repo}#${args.number} — ${args.prTitle}.`,
    "",
    `A review pass raised this finding on \`${location}\`:`,
    "",
    `**${finding.title}**`,
    "",
    finding.background === "" ? null : `Background: ${finding.background}`,
    `Problem: ${finding.problem}`,
    finding.suggestedFix === "" ? null : `Suggested fix: ${finding.suggestedFix}`,
    "",
    "Draft comment:",
    "",
    "> " + finding.suggestedComment.split("\n").join("\n> "),
    "",
    "Read the relevant code and the PR diff, then tell me whether this finding is",
    "correct, overstated, or wrong, and what the comment should actually say.",
    "Do not post anything to GitHub.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Pull request listing and filtering
// ---------------------------------------------------------------------------

export interface ReviewRequest {
  /** Set for user requests. */
  login: string | null;
  /** "org/team" for team requests. */
  teamSlug: string | null;
}

export interface PullRequest {
  repo: string;
  number: number;
  title: string;
  author: string;
  url: string;
  updatedAt: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefOid: string;
  baseRefName: string;
  headRefName: string;
  labels: string[];
  reviewRequests: ReviewRequest[];
}

interface GhPullRequest {
  number?: unknown;
  title?: unknown;
  author?: { login?: unknown } | null;
  url?: unknown;
  updatedAt?: unknown;
  isDraft?: unknown;
  additions?: unknown;
  deletions?: unknown;
  changedFiles?: unknown;
  headRefOid?: unknown;
  baseRefName?: unknown;
  headRefName?: unknown;
  labels?: Array<{ name?: unknown }> | null;
  reviewRequests?: Array<Record<string, unknown>> | null;
}

/** The `--json` field list `parsePullRequests` expects. */
export const PR_JSON_FIELDS = [
  "number",
  "title",
  "author",
  "url",
  "updatedAt",
  "isDraft",
  "additions",
  "deletions",
  "changedFiles",
  "headRefOid",
  "baseRefName",
  "headRefName",
  "labels",
  "reviewRequests",
].join(",");

export function parsePullRequests(raw: string, repo: string): PullRequest[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`gh returned a non-array PR list for ${repo}`);
  }
  return (parsed as GhPullRequest[])
    .filter((entry) => typeof entry?.number === "number")
    .map((entry) => ({
      repo,
      number: entry.number as number,
      title: str(entry.title),
      author: str(entry.author?.login),
      url: str(entry.url),
      updatedAt: str(entry.updatedAt),
      isDraft: entry.isDraft === true,
      additions: typeof entry.additions === "number" ? entry.additions : 0,
      deletions: typeof entry.deletions === "number" ? entry.deletions : 0,
      changedFiles: typeof entry.changedFiles === "number" ? entry.changedFiles : 0,
      headRefOid: str(entry.headRefOid),
      baseRefName: str(entry.baseRefName),
      headRefName: str(entry.headRefName),
      labels: (entry.labels ?? []).map((label) => str(label?.name)).filter((n) => n !== ""),
      reviewRequests: (entry.reviewRequests ?? []).map((request) => {
        // gh emits `{__typename: "Team", name, slug}` for teams (slug is
        // already "org/team") and `{__typename: "User", login}` for users.
        const isTeam = str(request.__typename) === "Team";
        return {
          login: isTeam ? null : str(request.login) || null,
          teamSlug: isTeam ? str(request.slug) || str(request.name) || null : null,
        };
      }),
    }));
}

export type PrFilter =
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "my-teams" }
  | { kind: "team"; teamSlug: string };

export interface FilterContext {
  viewer: string;
  /** "org/team" slugs the viewer belongs to. */
  myTeams: string[];
}

function requestedFromUser(pr: PullRequest, login: string): boolean {
  return pr.reviewRequests.some(
    (request) => request.login !== null && request.login.toLowerCase() === login.toLowerCase(),
  );
}

function requestedFromTeam(pr: PullRequest, teamSlug: string): boolean {
  return pr.reviewRequests.some(
    (request) =>
      request.teamSlug !== null && request.teamSlug.toLowerCase() === teamSlug.toLowerCase(),
  );
}

/**
 * Filter client-side rather than through GitHub's search qualifiers.
 * `review-requested:@me` silently folds in team requests, so it cannot tell
 * "someone asked me" apart from "someone asked a team I happen to be in" —
 * which is exactly the distinction this panel's filters exist to make.
 */
export function filterPullRequests(
  prs: PullRequest[],
  filter: PrFilter,
  context: FilterContext,
): PullRequest[] {
  switch (filter.kind) {
    case "all":
      return prs;
    case "mine":
      return prs.filter((pr) => requestedFromUser(pr, context.viewer));
    case "my-teams":
      return prs.filter((pr) => context.myTeams.some((team) => requestedFromTeam(pr, team)));
    case "team":
      return prs.filter((pr) => requestedFromTeam(pr, filter.teamSlug));
  }
}

// ---------------------------------------------------------------------------
// Unified patch splitting
// ---------------------------------------------------------------------------

export interface FilePatch {
  path: string;
  patch: string;
}

/**
 * Split `gh pr diff` output into one patch per file. BB's Diff component takes
 * a patch for exactly one file, and a PR diff is many.
 */
export function splitUnifiedDiff(diff: string): FilePatch[] {
  const files: FilePatch[] = [];
  let current: string[] | null = null;
  let path = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current !== null) files.push({ path, patch: current.join("\n") });
      current = [line];
      // `diff --git a/<path> b/<path>`; prefer the b-side (the new path).
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      path = match === null ? "" : match[2];
      continue;
    }
    if (current !== null) current.push(line);
  }
  if (current !== null) files.push({ path, patch: current.join("\n") });
  return files.filter((file) => file.path !== "");
}

/** `owner/name` from any GitHub remote URL (https, ssh, git@), else null. */
export function parseGithubRemote(url: string): string | null {
  const match = url
    .trim()
    .match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

export function isRepoName(value: unknown): value is string {
  return typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value);
}

/** Parse the multiline `repos` setting into a deduplicated owner/repo list. */
export function parseRepoList(value: string): string[] {
  const seen = new Set<string>();
  for (const entry of value.split(/[\s,]+/)) {
    const repo = entry.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (isRepoName(repo) && !seen.has(repo)) seen.add(repo);
  }
  return [...seen];
}

/** Parse the multiline `reviewSkills` setting into an ordered skill-name list. */
export function parseSkillList(value: string): string[] {
  const seen = new Set<string>();
  for (const entry of value.split(/[\s,]+/)) {
    const skill = entry.trim().replace(/^\//, "");
    if (skill !== "" && !seen.has(skill)) seen.add(skill);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Posting a comment
// ---------------------------------------------------------------------------

export interface PostCommentArgs {
  repo: string;
  number: number;
  body: string;
  /** Head commit the inline comment anchors to; unused for issue comments. */
  headSha: string;
  file: string;
  startLine: number | null;
  endLine: number | null;
  side: "LEFT" | "RIGHT";
  mode: "inline" | "issue";
}

/**
 * The `gh api` argv for posting one finding. Extracted from the request path
 * because GitHub's line rules are fiddly enough to be worth testing directly:
 * `line` is the LAST line of the range, `start_line` is only valid for a
 * genuine multi-line range, and a finding with no line anchor has to fall back
 * to a plain PR comment.
 */
export function buildPostCommentArgs(args: PostCommentArgs): string[] {
  if (args.mode === "issue" || args.startLine === null) {
    return [
      "api", "-X", "POST",
      `repos/${args.repo}/issues/${args.number}/comments`,
      "-f", `body=${args.body}`,
    ];
  }
  const end = args.endLine ?? args.startLine;
  const argv = [
    "api", "-X", "POST",
    `repos/${args.repo}/pulls/${args.number}/comments`,
    "-f", `body=${args.body}`,
    "-f", `commit_id=${args.headSha}`,
    "-f", `path=${args.file}`,
    "-F", `line=${end}`,
    "-f", `side=${args.side}`,
  ];
  if (end > args.startLine) {
    argv.push("-F", `start_line=${args.startLine}`, "-f", `start_side=${args.side}`);
  }
  return argv;
}

// ---------------------------------------------------------------------------
// The fetched PR snapshot
// ---------------------------------------------------------------------------
//
// The plugin fetches the PR once, when a review starts, and serves it to the
// review agent over the `bb code-review` CLI. That keeps GitHub access on the
// server — where gh is configured and unsandboxed — and pins the agent to one
// snapshot, so the line numbers in its findings match the diff it read even if
// the PR moves underneath it.

/** Combined stdout+stderr must fit PLUGIN_CLI_OUTPUT_MAX_BYTES (1 MiB); the
 *  host rejects an over-large result atomically rather than clipping it, so
 *  stay well under and page instead. */
export const CLI_OUTPUT_BUDGET = 800_000;

export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
  /** Set for inline review comments. */
  file: string | null;
  line: number | null;
}

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrSnapshot {
  title: string;
  body: string;
  author: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headSha: string;
  comments: PrComment[];
  reviewComments: PrComment[];
  files: ChangedFile[];
}

interface GhPrView {
  title?: unknown;
  body?: unknown;
  author?: { login?: unknown } | null;
  state?: unknown;
  isDraft?: unknown;
  baseRefName?: unknown;
  headRefName?: unknown;
  headRefOid?: unknown;
  comments?: Array<Record<string, unknown>> | null;
  files?: Array<Record<string, unknown>> | null;
}

/** The `--json` field list `parsePrSnapshot` expects from `gh pr view`. */
export const PR_VIEW_JSON_FIELDS = [
  "title",
  "body",
  "author",
  "state",
  "isDraft",
  "baseRefName",
  "headRefName",
  "headRefOid",
  "comments",
  "files",
].join(",");

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function commentAuthor(row: Record<string, unknown>): string {
  const author = row.author;
  if (typeof author === "object" && author !== null) {
    const login = str((author as Record<string, unknown>).login);
    if (login !== "") return login;
  }
  const user = row.user;
  if (typeof user === "object" && user !== null) {
    return str((user as Record<string, unknown>).login);
  }
  return "";
}

export function parsePrSnapshot(raw: string): PrSnapshot {
  const view = JSON.parse(raw) as GhPrView;
  return {
    title: str(view.title),
    body: str(view.body),
    author: str(view.author?.login),
    state: str(view.state),
    isDraft: view.isDraft === true,
    baseRefName: str(view.baseRefName),
    headRefName: str(view.headRefName),
    headSha: str(view.headRefOid),
    comments: (view.comments ?? []).map((row) => ({
      author: commentAuthor(row),
      body: str(row.body),
      createdAt: str(row.createdAt),
      file: null,
      line: null,
    })),
    reviewComments: [],
    files: (view.files ?? []).map((row) => ({
      path: str(row.path),
      additions: num(row.additions),
      deletions: num(row.deletions),
    })),
  };
}

/**
 * Inline review comments, from `gh api repos/{o}/{r}/pulls/{n}/comments`. A
 * repo can refuse this endpoint, so callers treat a failure as "no comments"
 * rather than failing the whole review.
 */
export function parseReviewComments(raw: string): PrComment[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return (parsed as Array<Record<string, unknown>>).map((row) => ({
    author: commentAuthor(row),
    body: str(row.body),
    createdAt: str(row.created_at),
    file: str(row.path) === "" ? null : str(row.path),
    line:
      typeof row.line === "number"
        ? row.line
        : typeof row.original_line === "number"
          ? row.original_line
          : null,
  }));
}

function renderComments(label: string, comments: PrComment[]): string[] {
  if (comments.length === 0) return [];
  const lines = [`## ${label}`, ""];
  for (const comment of comments) {
    const where = comment.file === null ? "" : ` on ${comment.file}${comment.line === null ? "" : `:${comment.line}`}`;
    lines.push(`### ${comment.author || "(unknown)"}${where}`, "", comment.body || "(empty)", "");
  }
  return lines;
}

/** The Markdown `bb code-review context` prints for the review agent. */
export function formatContext(reviewId: string, snapshot: PrSnapshot): string {
  const totals = snapshot.files.reduce(
    (acc, file) => ({ add: acc.add + file.additions, del: acc.del + file.deletions }),
    { add: 0, del: 0 },
  );
  return [
    `# ${reviewId} — ${snapshot.title}`,
    "",
    `- Author: ${snapshot.author || "(unknown)"}`,
    `- State: ${snapshot.state}${snapshot.isDraft ? " (draft)" : ""}`,
    `- Branch: ${snapshot.headRefName} → ${snapshot.baseRefName}`,
    `- Head commit: ${snapshot.headSha}`,
    `- Changes: ${snapshot.files.length} file${snapshot.files.length === 1 ? "" : "s"}, +${totals.add} −${totals.del}`,
    "",
    "## Description",
    "",
    snapshot.body.trim() === "" ? "(no description)" : snapshot.body,
    "",
    ...renderComments("Discussion", snapshot.comments),
    ...renderComments("Existing review comments", snapshot.reviewComments),
    "## Changed files",
    "",
    ...(snapshot.files.length === 0
      ? ["(none)"]
      : snapshot.files.map((file) => `- ${file.path} (+${file.additions} −${file.deletions})`)),
    "",
    `Read the diff with \`bb code-review diff --review ${reviewId}\`.`,
  ].join("\n");
}

/** The per-file table `diff` prints instead of a diff too large for one call. */
export function formatFileList(reviewId: string, files: FilePatch[]): string {
  return [
    `The diff is too large to print in one call (${files.length} files).`,
    "Read it one file at a time:",
    "",
    ...files.map(
      (file) => `    bb code-review diff --review ${reviewId} --file ${file.path}`,
    ),
  ].join("\n");
}
