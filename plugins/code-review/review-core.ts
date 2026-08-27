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

export const referenceSchema = z.object({
  file: z.string().trim().min(1),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  /** Why this location matters to the finding. */
  note: z.string().trim(),
});
export type Reference = z.infer<typeof referenceSchema>;

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
  /** The gist, for the list view: at most a few sentences. */
  summary: z.string().trim(),
  /** What the code is doing — the context needed to understand the issue. */
  background: z.string().trim(),
  /** What is actually wrong. */
  problem: z.string().trim().min(1),
  suggestedFix: z.string().trim(),
  /** Ready-to-post review comment text. */
  suggestedComment: z.string().trim().min(1),
  /** Other places in the repo this finding depends on or points at. */
  references: z.array(referenceSchema),
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
    title: firstString(row, ["title", "headline"]),
    summary: firstString(row, ["summary", "gist", "shortDescription"]),
    background: firstString(row, ["background", "context"]),
    problem: firstString(row, ["problem", "issue", "description", "detail"]),
    suggestedFix: firstString(row, ["suggestedFix", "suggested_fix", "fix"]),
    suggestedComment: firstString(row, [
      "suggestedComment",
      "suggested_comment",
      "comment",
    ]),
    references: normalizeReferences(row.references ?? row.related ?? row.seeAlso),
  };
}

function normalizeReferences(input: unknown): Reference[] {
  if (!Array.isArray(input)) return [];
  const references: Reference[] = [];
  for (const entry of input) {
    if (typeof entry === "string") {
      // A bare "path/to/file.ts:12-18" is a perfectly clear reference.
      references.push(...extractCitations(entry).map((cite) => ({ ...cite, note: "" })));
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const file = firstString(row, ["file", "path", "filename"]);
    if (file === "") continue;
    const start = firstLine(row, ["startLine", "start_line", "line", "lineStart"]);
    const end = firstLine(row, ["endLine", "end_line", "lineEnd", "line"]);
    references.push({
      file,
      startLine: start,
      endLine: end !== null && start !== null && end < start ? start : end,
      note: firstString(row, ["note", "why", "reason", "description"]),
    });
  }
  return references;
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
      "file": "src/server/auth.ts",       // FULL repo-relative path, never a bare filename
      "startLine": 42,                     // first affected line in the NEW file (null if none)
      "endLine": 45,                       // last affected line; same as startLine for one line
      "side": "RIGHT",                     // RIGHT = the new file, LEFT = the old file
      "severity": "blocker|high|medium|low|nit",
      "category": "correctness",           // free-form, e.g. correctness, security, tests, naming
      "title": "Session token is compared non-constant-time",
      "summary": "The gist, for the list view. Two sentences at most.",
      "background": "What this code does and the context a reader needs.",
      "problem": "What is actually wrong, and why it matters.",
      "suggestedFix": "How you would fix it.",
      "suggestedComment": "The exact review comment text to post on the PR.",
      "references": [                      // other code that supports the finding
        { "file": "src/server/session.ts",  // full repo-relative path here too
          "startLine": 88, "endLine": 92,
          "note": "the comparison this one should match" }
      ]
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
    "**Every path must be the full repo-relative path** — `e2e-tests/tests/login.spec.ts`,",
    "never `login.spec.ts`. That applies to `file`, to every `references` entry, and to any",
    "`path:line` you cite in your prose. Submitting is rejected if a path is not a real file",
    "in the repository, so use `bb code-review files` or the diff to check one you are unsure of.",
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
  // Careful: "mine" means a review was requested from you, while "authored"
  // means you opened it. They are different lists and neither implies the
  // other.
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "my-teams" }
  | { kind: "team"; teamSlug: string }
  | { kind: "authored" };

export interface FilterContext {
  viewer: string;
  /** "org/team" slugs the viewer belongs to. */
  myTeams: string[];
}

function isViewer(login: string, viewer: string): boolean {
  return login.toLowerCase() === viewer.toLowerCase();
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
  // The one filter that is explicitly about your own work.
  if (filter.kind === "authored") {
    return prs.filter((pr) => isViewer(pr.author, context.viewer));
  }
  // Everywhere else your own pull requests are not yours to review — GitHub
  // will not even accept a self-review — so they are left out.
  const reviewable = prs.filter((pr) => !isViewer(pr.author, context.viewer));
  switch (filter.kind) {
    case "all":
      return reviewable;
    case "mine":
      return reviewable.filter((pr) => requestedFromUser(pr, context.viewer));
    case "my-teams":
      return reviewable.filter((pr) =>
        context.myTeams.some((team) => requestedFromTeam(pr, team)),
      );
    case "team":
      return reviewable.filter((pr) => requestedFromTeam(pr, filter.teamSlug));
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
  kind: PostKind;
}

/**
 * The `gh api` argv for posting one finding. Extracted from the request path
 * because GitHub's line rules are fiddly enough to be worth testing directly:
 * `line` is the LAST line of the range, `start_line` is only valid for a
 * genuine multi-line range, and a finding with no line anchor has to fall back
 * to a plain PR comment.
 */
export function buildPostCommentArgs(args: PostCommentArgs): string[] {
  if (args.kind === "pull-request") {
    return [
      "api", "-X", "POST",
      `repos/${args.repo}/issues/${args.number}/comments`,
      "-f", `body=${args.body}`,
    ];
  }
  // A file-level comment: GitHub accepts it for any file the PR touches, and
  // shows it against that file rather than at the bottom of the conversation.
  if (args.kind === "file" || args.startLine === null) {
    return [
      "api", "-X", "POST",
      `repos/${args.repo}/pulls/${args.number}/comments`,
      "-f", `body=${args.body}`,
      "-f", `commit_id=${args.headSha}`,
      "-f", `path=${args.file}`,
      "-f", "subject_type=file",
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

// ---------------------------------------------------------------------------
// Where a finding points
// ---------------------------------------------------------------------------

/** Extensions a `path:line` citation is allowed to end in. Without this,
 *  "github.com:443" and similar read as file references. */
const SOURCE_EXTENSIONS = new Set([
  "bash", "c", "cc", "cjs", "conf", "cpp", "cs", "css", "dart", "ex", "exs",
  "go", "gql", "gradle", "graphql", "h", "hpp", "html", "ini", "java", "js",
  "json", "jsx", "kt", "kts", "less", "lua", "m", "md", "mdx", "mjs", "mm",
  "php", "pl", "proto", "py", "r", "rb", "rs", "sass", "scala", "scss", "sh",
  "sql", "svelte", "swift", "tf", "toml", "ts", "tsx", "vue", "xml", "yaml",
  "yml", "zsh",
]);

const CITATION = /((?:[\w.@-]+\/)*[\w.@-]+\.([A-Za-z0-9]{1,8})):(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/g;

export interface Citation {
  file: string;
  startLine: number | null;
  endLine: number | null;
}

/**
 * Pull `path/to/file.ts:42` / `file.ts:42-48` references out of prose. Agents
 * cite supporting code inline far more often than they fill in a structured
 * field, and those citations are exactly the code worth showing next to the
 * finding.
 */
export function extractCitations(text: string): Citation[] {
  const found: Citation[] = [];
  for (const match of text.matchAll(CITATION)) {
    const [whole, file, extension, start, end] = match;
    if (!SOURCE_EXTENSIONS.has((extension ?? "").toLowerCase())) continue;
    // Skip the tail of a URL, where the "path" is a host and the "line" a port.
    const before = text.slice(Math.max(0, (match.index ?? 0) - 12), match.index ?? 0);
    if (before.includes("://")) continue;
    void whole;
    const startLine = Number(start);
    const endLine = end === undefined ? startLine : Number(end);
    found.push({
      file: file as string,
      startLine,
      endLine: endLine < startLine ? startLine : endLine,
    });
  }
  return found;
}

export interface FindingLocation {
  file: string;
  startLine: number | null;
  endLine: number | null;
  /** Why this location matters; empty for the finding's own site. */
  note: string;
  /** True for the file the finding is filed against. */
  isPrimary: boolean;
}

function locationKey(location: { file: string; startLine: number | null }): string {
  return `${location.file}:${location.startLine ?? ""}`;
}

/**
 * Every place a finding points at, in the order to show them: its own site
 * first, then anything it explicitly referenced, then anything it cited in
 * prose. Deduplicated, because a finding usually does all three for the same
 * line.
 */
export function findingLocations(
  finding: {
    file: string;
    startLine: number | null;
    endLine: number | null;
    summary?: string;
    background: string;
    problem: string;
    suggestedFix: string;
    references?: Reference[];
  },
  /**
   * Maps a cited path to its real one. Applied BEFORE deduplication, so a
   * finding that says both "a.ts:10" and "src/a.ts:10" yields one location
   * rather than two of the same line.
   */
  resolvePath: (file: string) => string = (file) => file,
): FindingLocation[] {
  const locations: FindingLocation[] = [
    {
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      note: "",
      isPrimary: true,
    },
  ];
  for (const reference of finding.references ?? []) {
    locations.push({ ...reference, isPrimary: false });
  }
  const prose = [
    finding.summary ?? "",
    finding.background,
    finding.problem,
    finding.suggestedFix,
  ].join("\n");
  for (const citation of extractCitations(prose)) {
    locations.push({ ...citation, note: "", isPrimary: false });
  }
  const seen = new Set<string>();
  return locations
    .map((location) => ({ ...location, file: resolvePath(location.file) }))
    .filter((location) => {
      const key = locationKey(location);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Trim prose to a sentence boundary near `limit` characters. */
function clampSentences(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= limit) return collapsed;
  const cut = collapsed.slice(0, limit);
  const boundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  return boundary > limit * 0.5 ? cut.slice(0, boundary + 1) : `${cut.trimEnd()}…`;
}

/**
 * The gist for the list view. Prefers what the agent wrote, and falls back to
 * the problem statement so findings recorded before `summary` existed still
 * read well.
 */
export function findingGist(finding: { summary?: string; problem: string }): string {
  const summary = (finding.summary ?? "").trim();
  return clampSentences(summary === "" ? finding.problem : summary, 240);
}

// ---------------------------------------------------------------------------
// GitHub deep links
// ---------------------------------------------------------------------------

/**
 * A permalink to a file at a commit, with the lines highlighted.
 *
 * Used for lines outside the diff, where a PR-diff anchor scrolls nowhere:
 * the blob view always shows the code, at the exact commit reviewed.
 */
export function githubBlobUrl(args: {
  repo: string;
  sha: string;
  file: string;
  startLine: number | null;
  endLine: number | null;
}): string {
  const path = args.file.split("/").map(encodeURIComponent).join("/");
  const base = `https://github.com/${args.repo}/blob/${args.sha}/${path}`;
  if (args.startLine === null) return base;
  const end = args.endLine;
  return end !== null && end !== args.startLine
    ? `${base}#L${args.startLine}-L${end}`
    : `${base}#L${args.startLine}`;
}

export function githubPrUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

/**
 * A PR's diff, anchored at one file and optionally one line. GitHub anchors
 * each file by `diff-<sha256 of the repo-relative path>`; the caller supplies
 * that digest so this stays free of a crypto dependency.
 */
export function githubPrFileUrl(args: {
  repo: string;
  number: number;
  pathDigest: string;
  line?: number | null;
  side?: "LEFT" | "RIGHT";
}): string {
  const suffix =
    args.line == null ? "" : `${args.side === "LEFT" ? "L" : "R"}${args.line}`;
  return `${githubPrUrl(args.repo, args.number)}/files#diff-${args.pathDigest}${suffix}`;
}

/**
 * Resolve a cited path against the paths the PR actually touches.
 *
 * Agents cite bare filenames constantly — "login.spec.ts:28" when the file is
 * really "e2e-tests/tests/login.spec.ts". Left alone those 404, so a useful
 * reference turns into a broken row. A suffix match against the PR's own file
 * list fixes the common case; anything ambiguous is left exactly as written
 * rather than guessed at.
 */
/** Directory segments of a path, e.g. "a/b/c.ts" -> ["a", "b"]. */
function directorySegments(path: string): string[] {
  return path.split("/").slice(0, -1);
}

/** How many leading directory segments two paths share. */
function sharedDepth(a: string, b: string): number {
  const left = directorySegments(a);
  const right = directorySegments(b);
  let depth = 0;
  while (depth < left.length && depth < right.length && left[depth] === right[depth]) depth += 1;
  return depth;
}

function pickCandidate(file: string, paths: readonly string[], nearTo: string): string | null {
  if (paths.includes(file)) return file;
  const candidates = paths.filter((candidate) => candidate.endsWith(`/${file}`));
  if (candidates.length <= 1) return candidates[0] ?? null;
  if (nearTo === "") return null;
  // Several files share this name — "index.ts" and friends are a quarter of a
  // real repo — so rank by how much of the directory path they share with the
  // file the finding is about.
  const ranked = candidates
    .map((candidate) => ({ candidate, depth: sharedDepth(candidate, nearTo) }))
    .sort((a, b) => b.depth - a.depth);
  const best = ranked[0];
  if (best === undefined) return null;
  // A tie at the top is a genuine coin flip; leave it unresolved.
  if (ranked[1]?.depth === best.depth) return null;
  // Sharing only a top-level directory is not proximity: for a finding in
  // packages/shared/src/orpc/procedures, "packages/theme/src/index.ts" shares
  // one segment and is plainly the wrong index.ts. Require the candidate to
  // sit under at least half of the target's directories.
  return best.depth * 2 >= directorySegments(nearTo).length ? best.candidate : null;
}

/**
 * Resolve a cited path against the repo.
 *
 * Findings are required to carry full repo-relative paths and `bb code-review
 * submit` rejects ones that do not, so this is a fallback for the times an
 * agent does it anyway, and for findings recorded before the rule existed.
 * Exact match wins, then a single possibility, then the candidate nearest the
 * file the finding is about. A real tie is left as written.
 */
export function resolveCitedPath(
  file: string,
  /** The PR's own files, tried first — the likeliest thing a review means. */
  preferredPaths: readonly string[],
  /** Every path in the repo, for code the PR does not touch. */
  allPaths: readonly string[] = [],
  /** The finding's own file; ties break toward its neighbours. */
  nearTo = "",
): string {
  return (
    pickCandidate(file, preferredPaths, nearTo) ??
    pickCandidate(file, allPaths, nearTo) ??
    file
  );
}

/** Every path in the repo that a citation could plausibly have meant. */
export function citationCandidates(
  file: string,
  allPaths: readonly string[],
): string[] {
  return allPaths.filter((candidate) => candidate === file || candidate.endsWith(`/${file}`));
}

/** True when a path still looks like a bare or partial citation. */
export function needsPathResolution(file: string, knownPaths: readonly string[]): boolean {
  return !knownPaths.includes(file);
}


/** A finding path that does not name a real file in the repository. */
export interface BadPath {
  /** 1-based index of the finding in the submitted file. */
  finding: number;
  field: string;
  file: string;
  candidates: string[];
}

/**
 * Check every path a report cites against the repository's real paths.
 *
 * This is what makes "use full repo-relative paths" more than advice: submit
 * refuses the file and names each bad path, so the agent fixes them rather
 * than leaving the panel to guess later.
 */
export function findBadPaths(
  findings: readonly Finding[],
  repoPaths: readonly string[],
): BadPath[] {
  if (repoPaths.length === 0) return [];
  const known = new Set(repoPaths);
  const bad: BadPath[] = [];
  const check = (index: number, field: string, file: string) => {
    if (known.has(file)) return;
    bad.push({
      finding: index + 1,
      field,
      file,
      candidates: citationCandidates(file, repoPaths).slice(0, 5),
    });
  };
  findings.forEach((finding, index) => {
    check(index, "file", finding.file);
    finding.references.forEach((reference, refIndex) => {
      check(index, `references[${refIndex}].file`, reference.file);
    });
  });
  return bad;
}

/** The message `submit` prints when a report cites paths that do not exist. */
export function formatBadPaths(bad: readonly BadPath[]): string {
  return [
    `${bad.length} path${bad.length === 1 ? " does" : "s do"} not name a real file in the repository.`,
    "Use the full repo-relative path, as `bb code-review files` lists them:",
    "",
    ...bad.map((entry) => {
      const suggestion =
        entry.candidates.length === 1
          ? `  -> did you mean ${entry.candidates[0]}?`
          : entry.candidates.length > 1
            ? `  -> could be: ${entry.candidates.join(", ")}`
            : "  -> no file with that name exists at this commit";
      return `finding ${entry.finding}, ${entry.field}: ${entry.file}\n${suggestion}`;
    }),
    "",
    "Fix the paths and submit again.",
  ].join("\n");
}

/**
 * Turn a failed `gh api` call into something a reader can act on.
 *
 * gh writes the API response body to stdout and a one-line summary to stderr,
 * so reporting stderr alone reduces "user_id can only have one pending review
 * per pull request" to "Validation Failed (HTTP 422)" — the useful half is
 * exactly the half that was being dropped.
 */
export function describeGitHubError(stdout: string, stderr: string): string {
  const short = stderr.trim();
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null) return short;
    const row = parsed as { message?: unknown; errors?: unknown };
    const details = Array.isArray(row.errors)
      ? row.errors
          .map((entry) => {
            if (typeof entry === "string") return entry;
            if (typeof entry !== "object" || entry === null) return "";
            const detail = entry as { message?: unknown; code?: unknown; field?: unknown };
            if (typeof detail.message === "string") return detail.message;
            return typeof detail.code === "string"
              ? `${String(detail.field ?? "")} ${detail.code}`.trim()
              : "";
          })
          .filter((entry) => entry !== "")
      : [];
    const message = typeof row.message === "string" ? row.message : "";
    const full = [message, ...details].filter((entry) => entry !== "").join(" — ");
    return full === "" ? short : full;
  } catch {
    // Not a JSON body (network error, gh usage error); stderr is all there is.
    return short;
  }
}

// ---------------------------------------------------------------------------
// Where GitHub will actually accept a comment
// ---------------------------------------------------------------------------

export interface LineRange {
  start: number;
  end: number;
}

/**
 * The line ranges a unified patch covers, on one side of the diff.
 *
 * GitHub only accepts an inline comment on a line inside a diff hunk. A
 * finding's range routinely runs past one — it describes code, not a hunk — so
 * posting has to be checked against these rather than hoped for.
 */
export function diffHunkRanges(patch: string, side: "LEFT" | "RIGHT"): LineRange[] {
  const ranges: LineRange[] = [];
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  for (const line of patch.split("\n")) {
    const match = line.match(header);
    if (match === null) continue;
    const start = Number(side === "LEFT" ? match[1] : match[3]);
    const countRaw = side === "LEFT" ? match[2] : match[4];
    const count = countRaw === undefined ? 1 : Number(countRaw);
    if (!Number.isFinite(start) || count <= 0) continue;
    ranges.push({ start, end: start + count - 1 });
  }
  return ranges;
}

function inAnyRange(line: number, ranges: readonly LineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

/**
 * How a comment can be attached, best first.
 *
 * - `line`: anchored to the lines, which GitHub allows only inside a diff hunk.
 * - `file`: attached to the file in the diff view. GitHub accepts this for any
 *   file in the pull request, which is most findings whose lines fall outside
 *   a hunk — much better placement than the bottom of the conversation.
 * - `pull-request`: a plain comment, the only option for a file the pull
 *   request does not touch.
 */
export type PostKind = "line" | "file" | "pull-request";

export interface PostAnchor {
  kind: PostKind;
  /** The line GitHub will anchor to; null for file and pull-request comments. */
  line: number | null;
  /** Start of a multi-line comment, or null for a single-line one. */
  startLine: number | null;
  /** True when the finding's own range had to be narrowed to fit the diff. */
  adjusted: boolean;
}

/**
 * The best attachment GitHub will accept for a finding.
 *
 * A finding's range is about the code, so it often overhangs the diff — the
 * range 137-139 against hunks ending at 137 is rejected outright, because
 * GitHub anchors at the last line. Narrowing to the part that is in the diff
 * puts the comment where the reviewer meant it instead of failing.
 */
export function resolvePostAnchor(
  finding: { startLine: number | null; endLine: number | null },
  ranges: readonly LineRange[],
  /** Whether the pull request touches this file at all. */
  fileInDiff = true,
): PostAnchor {
  const fallback: PostAnchor = fileInDiff
    ? { kind: "file", line: null, startLine: null, adjusted: false }
    : { kind: "pull-request", line: null, startLine: null, adjusted: false };
  if (finding.startLine === null) return fallback;
  // With no diff to check against, trust the finding and let GitHub rule.
  if (ranges.length === 0) {
    if (!fileInDiff) return fallback;
    const end = finding.endLine ?? finding.startLine;
    return {
      kind: "line",
      line: end,
      startLine: end > finding.startLine ? finding.startLine : null,
      adjusted: false,
    };
  }
  const wanted = { start: finding.startLine, end: finding.endLine ?? finding.startLine };
  const covered: number[] = [];
  for (let line = wanted.start; line <= wanted.end; line += 1) {
    if (inAnyRange(line, ranges)) covered.push(line);
  }
  if (covered.length === 0) return fallback;
  const line = covered[covered.length - 1] as number;
  const start = covered[0] as number;
  // A comment range must sit inside one hunk, so only span back as far as the
  // contiguous run ending at the anchor.
  let contiguousStart = line;
  while (contiguousStart > start && covered.includes(contiguousStart - 1)) {
    contiguousStart -= 1;
  }
  return {
    kind: "line",
    line,
    startLine: contiguousStart < line ? contiguousStart : null,
    adjusted: line !== wanted.end || contiguousStart !== wanted.start,
  };
}

/**
 * A quoted excerpt with a link, to prepend to a comment that cannot be
 * anchored to a line.
 *
 * A general pull request comment appears at the bottom of the conversation
 * with no code beside it, so a comment written about a specific line reads as
 * a non-sequitur. Carrying the code and a permalink into the body is the only
 * way to keep it legible.
 */
export function buildFileContextBlock(args: {
  file: string;
  startLine: number | null;
  endLine: number | null;
  blobUrl: string;
  /** The window fetched for the panel, starting at `firstLine`. */
  lines: readonly string[];
  firstLine: number;
}): string {
  const label =
    args.startLine === null
      ? args.file
      : args.endLine !== null && args.endLine !== args.startLine
        ? `${args.file}:${args.startLine}-${args.endLine}`
        : `${args.file}:${args.startLine}`;
  const link = `[\`${label}\`](${args.blobUrl})`;
  if (args.startLine === null || args.lines.length === 0) return link;

  // Quote only the cited lines; the surrounding context the panel shows is
  // there for the reviewer, not for the pull request.
  const from = Math.max(0, args.startLine - args.firstLine);
  const to = Math.max(from, (args.endLine ?? args.startLine) - args.firstLine);
  const quoted = args.lines.slice(from, to + 1);
  if (quoted.length === 0) return link;

  // Only a real extension: "Makefile" has no dot, and taking its whole name
  // as the fence language is nonsense.
  const name = args.file.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  const language = /^[A-Za-z0-9]{1,10}$/.test(extension) ? extension.toLowerCase() : "";
  return [link, "", `\`\`\`${language}`, ...quoted, "\`\`\`"].join("\n");
}
