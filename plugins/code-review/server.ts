// bb-plugin-code-review — backend.
//
// The loop this plugin implements:
//
//   1. List a repo's open PRs, filtered by who was asked to review (me, one of
//      my teams, any of my teams, everyone).
//   2. Open a PR, start a review: a BB thread runs the review skills you
//      configured and writes structured findings to a JSON file, then submits
//      that file with `bb code-review submit`.
//   3. Each finding lands in the panel with its background, the problem, a
//      suggested fix, and a ready-to-post comment you can edit, post to
//      GitHub, or open a discussion thread about.
//
// gh is the only GitHub transport, so whatever `gh auth` can see, this can.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  buildDiscussionPrompt,
  buildPostCommentArgs,
  buildReviewPrompt,
  CLI_OUTPUT_BUDGET,
  FINDINGS_SCHEMA_TEXT,
  findingGist,
  findingLocations,
  formatContext,
  formatFileList,
  githubPrFileUrl,
  githubPrUrl,
  needsPathResolution,
  resolveCitedPath,
  filterPullRequests,
  isRepoName,
  parseGithubRemote,
  parsePullRequests,
  parseReport,
  parsePrSnapshot,
  parseRepoList,
  parseReviewComments,
  parseSkillList,
  PR_JSON_FIELDS,
  PR_VIEW_JSON_FIELDS,
  severityRank,
  SEVERITIES,
  splitUnifiedDiff,
  type Finding,
  type FilePatch,
  type FindingLocation,
  type PrSnapshot,
  type PullRequest,
} from "./review-core";

const CHANGED = "code-review-changed";
const GH_HINT =
  "Install the GitHub CLI and run `gh auth login`, then reload the plugin.";
const GH_HOST = "github.com";
const GH_NO_CREDENTIALS = /no oauth token|not logged in/i;
const VIEWER_CACHE_MS = 60 * 60_000;
const TEAM_CACHE_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

const reviewRequestSchema = z.object({
  login: z.string().nullable(),
  teamSlug: z.string().nullable(),
});

const pullRequestSchema = z.object({
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  author: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  headRefOid: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  labels: z.array(z.string()),
  reviewRequests: z.array(reviewRequestSchema),
  /** Status of this plugin's review of the PR, if one has been started. */
  reviewStatus: z.enum(["none", "queued", "running", "reported", "failed"]),
  openFindings: z.number(),
  postedFindings: z.number(),
});
export type PullRequestDto = z.infer<typeof pullRequestSchema>;

const findingSchemaDto = z.object({
  id: z.string(),
  reviewId: z.string(),
  file: z.string(),
  startLine: z.number().nullable(),
  endLine: z.number().nullable(),
  side: z.enum(["LEFT", "RIGHT"]),
  severity: z.enum(SEVERITIES),
  category: z.string(),
  title: z.string(),
  /** The gist for the list view; derived when the agent wrote none. */
  gist: z.string(),
  summary: z.string(),
  background: z.string(),
  problem: z.string(),
  suggestedFix: z.string(),
  suggestedComment: z.string(),
  /** The user's edit, or null when the suggested comment is unedited. */
  draftComment: z.string().nullable(),
  state: z.enum(["open", "posted", "dismissed"]),
  commentUrl: z.string().nullable(),
  postedAt: z.string().nullable(),
  discussionThreadId: z.string().nullable(),
  references: z.array(
    z.object({
      file: z.string(),
      startLine: z.number().nullable(),
      endLine: z.number().nullable(),
      note: z.string(),
    }),
  ),
});
export type FindingDto = z.infer<typeof findingSchemaDto>;

const reviewSchema = z.object({
  id: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  status: z.enum(["queued", "running", "reported", "failed"]),
  summary: z.string(),
  error: z.string().nullable(),
  threadId: z.string().nullable(),
  findingsPath: z.string().nullable(),
  skills: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReviewDto = z.infer<typeof reviewSchema>;

const statusSchema = z.object({
  state: z.enum(["ready", "needs_configuration", "unavailable", "checking"]),
  detail: z.string().nullable(),
  viewer: z.string().nullable(),
  repos: z.array(z.string()),
  myTeams: z.array(z.string()),
  skills: z.array(z.string()),
});

const filterSchema = z.union([
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("mine") }),
  z.object({ kind: z.literal("my-teams") }),
  z.object({ kind: z.literal("team"), teamSlug: z.string() }),
]);

const codeLocationSchema = z.object({
  file: z.string(),
  startLine: z.number().nullable(),
  endLine: z.number().nullable(),
  note: z.string(),
  isPrimary: z.boolean(),
  /** The PR's diff for this file, anchored at the cited line. */
  diffUrl: z.string(),
  /** First line number in `lines`; 1-based. */
  firstLine: z.number(),
  lines: z.array(z.string()),
  /** Lines exist above/below what was returned. */
  hasMoreAbove: z.boolean(),
  hasMoreBelow: z.boolean(),
  /** Why the code could not be shown, if it could not. */
  error: z.string().nullable(),
});

const panelStateSchema = z.object({
  repo: z.string().nullable(),
  filter: filterSchema.nullable(),
});

export const rpcContract = defineRpcContract({
  status: { input: z.null(), output: statusSchema },
  listPullRequests: {
    input: z.object({
      repo: z.string(),
      filter: filterSchema,
      refresh: z.boolean().optional(),
    }),
    output: z.object({
      /** When this list was last pulled from GitHub. */
      fetchedAt: z.string(),
      pullRequests: z.array(pullRequestSchema),
    }),
  },
  getPullRequest: {
    input: z.object({ repo: z.string(), number: z.number().int().positive() }),
    output: z.object({
      pullRequest: pullRequestSchema.nullable(),
      review: reviewSchema.nullable(),
      findings: z.array(findingSchemaDto),
    }),
  },
  startReview: {
    input: z.object({
      repo: z.string(),
      number: z.number().int().positive(),
      /** Overrides the configured skill list for this run only. */
      skills: z.array(z.string()).optional(),
    }),
    output: z.object({ review: reviewSchema }),
  },
  setFindingComment: {
    input: z.object({ findingId: z.string(), comment: z.string() }),
    output: z.object({ finding: findingSchemaDto }),
  },
  setFindingState: {
    input: z.object({
      findingId: z.string(),
      state: z.enum(["open", "dismissed"]),
    }),
    output: z.object({ finding: findingSchemaDto }),
  },
  postFinding: {
    input: z.object({
      findingId: z.string(),
      /** "inline" anchors to the file and line; "issue" is a plain PR comment. */
      mode: z.enum(["inline", "issue"]),
    }),
    output: z.object({ finding: findingSchemaDto }),
  },
  discussFinding: {
    input: z.object({ findingId: z.string() }),
    output: z.object({ threadId: z.string() }),
  },
  getFindingCode: {
    input: z.object({
      findingId: z.string(),
      /** Lines of surrounding context above and below each cited range. */
      context: z.number().int().min(0).max(200).optional(),
    }),
    output: z.object({
      prUrl: z.string(),
      headSha: z.string(),
      /** False when the code was fetched after the review, so lines may have moved. */
      isReviewedCommit: z.boolean(),
      locations: z.array(codeLocationSchema),
    }),
  },
  getPanelState: { input: z.null(), output: panelStateSchema },
  setPanelState: { input: panelStateSchema, output: panelStateSchema },
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function needsConfiguration(message: string): Error {
  return Object.assign(new Error(message), { name: "NeedsConfigurationError" });
}

function isNeedsConfigurationError(error: unknown): boolean {
  return error instanceof Error && error.name === "NeedsConfigurationError";
}

function run(
  file: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${path.basename(file)} ${args.slice(0, 3).join(" ")} failed: ${
                stderr.trim() || error.message
              }`,
            ),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
  });
}

function reviewIdFor(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requireRepo(repo: string): string {
  if (!isRepoName(repo)) throw new Error(`Invalid repository "${repo}"; expected owner/repo.`);
  return repo;
}

/** The comment text that would actually be posted: the edit, else the suggestion. */
function effectiveComment(finding: FindingDto): string {
  return finding.draftComment ?? finding.suggestedComment;
}

const REVIEW_STATUSES = ["queued", "running", "reported", "failed"] as const;
type ReviewStatus = (typeof REVIEW_STATUSES)[number];

function isReviewStatus(value: string): value is ReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(value);
}

function isSeverity(value: string): value is FindingDto["severity"] {
  return (SEVERITIES as readonly string[]).includes(value);
}

/** Read one string field out of a `gh --json` / `gh api` response. */
function ghField(raw: string, field: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return "";
  const value = (parsed as Record<string, unknown>)[field];
  return typeof value === "string" ? value : "";
}

interface ReviewRow {
  id: string;
  repo: string;
  number: number;
  title: string;
  status: string;
  summary: string;
  error: string | null;
  thread_id: string | null;
  findings_path: string | null;
  skills: string;
  created_at: string;
  updated_at: string;
}

interface FindingRow {
  id: string;
  review_id: string;
  ord: number;
  file: string;
  start_line: number | null;
  end_line: number | null;
  side: string;
  severity: string;
  category: string;
  title: string;
  summary: string;
  background: string;
  problem: string;
  suggested_fix: string;
  suggested_comment: string;
  draft_comment: string | null;
  state: string;
  comment_url: string | null;
  posted_at: string | null;
  discussion_thread_id: string | null;
  references_json: string;
}

function toReviewDto(row: ReviewRow): ReviewDto {
  return {
    id: row.id,
    repo: row.repo,
    number: row.number,
    title: row.title,
    // A row whose status the current build no longer knows is shown as failed
    // rather than crashing the panel's output validation.
    status: isReviewStatus(row.status) ? row.status : "failed",
    summary: row.summary,
    error: row.error,
    threadId: row.thread_id,
    findingsPath: row.findings_path,
    skills: JSON.parse(row.skills) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toFindingDto(row: FindingRow): FindingDto {
  return {
    id: row.id,
    reviewId: row.review_id,
    file: row.file,
    startLine: row.start_line,
    endLine: row.end_line,
    side: row.side === "LEFT" ? "LEFT" : "RIGHT",
    severity: isSeverity(row.severity) ? row.severity : "medium",
    category: row.category,
    title: row.title,
    summary: row.summary ?? "",
    gist: findingGist({ summary: row.summary ?? "", problem: row.problem }),
    background: row.background,
    problem: row.problem,
    suggestedFix: row.suggested_fix,
    suggestedComment: row.suggested_comment,
    draftComment: row.draft_comment,
    state:
      row.state === "posted" ? "posted" : row.state === "dismissed" ? "dismissed" : "open",
    commentUrl: row.comment_url,
    postedAt: row.posted_at,
    discussionThreadId: row.discussion_thread_id,
    references: parseJsonArray(row.references_json),
  };
}

/** Stored JSON that predates a column, or was written by an older build. */
function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (raw == null || raw === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

/**
 * How the plugin shells out. The real host never passes this — it exists so
 * tests can drive gh and git without a GitHub account or a checkout.
 */
export interface PluginDependencies {
  runCommand?: (
    file: string,
    args: string[],
    timeoutMs?: number,
  ) => Promise<{ stdout: string; stderr: string }>;
}

export default async function plugin(bb: BbPluginApi, deps: PluginDependencies = {}) {
  const runCommand = deps.runCommand ?? run;
  const settings = bb.settings.define({
    repos: {
      type: "string",
      label: "Repositories",
      description:
        'One "owner/repo" per line, in addition to repos discovered from your BB projects\' git remotes.',
      experimental_multiline: true,
      default: "",
    },
    reviewSkills: {
      type: "string",
      label: "Review skills",
      description:
        "Skill names the review agent should run, one per line (for example `code-review`). Leave empty for a generic review.",
      experimental_multiline: true,
      default: "code-review",
    },
    reviewInstructions: {
      type: "string",
      label: "Extra review instructions",
      description:
        "Appended to every review prompt — house rules, things to always check, things to never comment on.",
      experimental_multiline: true,
      default: "",
    },
    findingsDir: {
      type: "string",
      label: "Findings directory",
      description:
        "Where the review agent writes its findings JSON, relative to the checkout.",
      default: ".bb/code-review",
    },
    defaultProject: {
      type: "project",
      label: "Default BB project",
      description:
        "Where review threads spawn for repos that are not attached to a BB project.",
    },
    teams: {
      type: "string",
      label: "Teams",
      description:
        'One "org/team" per line. Leave empty to use the teams `gh api /user/teams` reports.',
      experimental_multiline: true,
      default: "",
    },
  });

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------
  const db: Database.Database = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS reviews (
       id TEXT PRIMARY KEY,
       repo TEXT NOT NULL,
       number INTEGER NOT NULL,
       title TEXT NOT NULL DEFAULT '',
       status TEXT NOT NULL DEFAULT 'queued',
       summary TEXT NOT NULL DEFAULT '',
       error TEXT,
       thread_id TEXT,
       findings_path TEXT,
       skills TEXT NOT NULL DEFAULT '[]',
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS findings (
       id TEXT PRIMARY KEY,
       review_id TEXT NOT NULL,
       ord INTEGER NOT NULL DEFAULT 0,
       file TEXT NOT NULL DEFAULT '',
       start_line INTEGER,
       end_line INTEGER,
       side TEXT NOT NULL DEFAULT 'RIGHT',
       severity TEXT NOT NULL DEFAULT 'medium',
       category TEXT NOT NULL DEFAULT '',
       title TEXT NOT NULL DEFAULT '',
       background TEXT NOT NULL DEFAULT '',
       problem TEXT NOT NULL DEFAULT '',
       suggested_fix TEXT NOT NULL DEFAULT '',
       suggested_comment TEXT NOT NULL DEFAULT '',
       draft_comment TEXT,
       state TEXT NOT NULL DEFAULT 'open',
       comment_url TEXT,
       posted_at TEXT,
       discussion_thread_id TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS findings_by_review ON findings (review_id)`,
    `CREATE INDEX IF NOT EXISTS reviews_by_thread ON reviews (thread_id)`,
    // The PR as fetched when the review started. Held so the review agent
    // never needs gh or network access of its own, and so its findings' line
    // numbers refer to one stable diff.
    `CREATE TABLE IF NOT EXISTS review_context (
       review_id TEXT PRIMARY KEY,
       snapshot TEXT NOT NULL,
       diff TEXT NOT NULL DEFAULT '',
       fetched_at TEXT NOT NULL
     )`,
    // File bodies at the reviewed commit, so the panel can show the code a
    // finding points at without refetching on every render.
    `CREATE TABLE IF NOT EXISTS review_files (
       review_id TEXT NOT NULL,
       path TEXT NOT NULL,
       content TEXT,
       error TEXT,
       fetched_at TEXT NOT NULL,
       PRIMARY KEY (review_id, path)
     )`,
    // Panel state, so re-opening the tab does not mean re-choosing the repo.
    `CREATE TABLE IF NOT EXISTS panel_state (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       repo TEXT,
       filter TEXT,
       updated_at TEXT NOT NULL
     )`,
    `ALTER TABLE findings ADD COLUMN summary TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE findings ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]'`,
    // The PR list survives reloads and restarts, and is only re-fetched when
    // the user asks for it.
    `CREATE TABLE IF NOT EXISTS pr_cache (
       repo TEXT PRIMARY KEY,
       prs TEXT NOT NULL,
       fetched_at TEXT NOT NULL
     )`,
    `ALTER TABLE review_context ADD COLUMN at_review_start INTEGER NOT NULL DEFAULT 1`,
    // The repo's file list at the reviewed commit, so a citation to code the
    // PR does not touch can still be resolved to a real path.
    `CREATE TABLE IF NOT EXISTS repo_tree (
       review_id TEXT PRIMARY KEY,
       paths TEXT NOT NULL,
       fetched_at TEXT NOT NULL
     )`,
  ]);

  function getReview(reviewId: string): ReviewRow | null {
    return (db.prepare(`SELECT * FROM reviews WHERE id = ?`).get(reviewId) as
      | ReviewRow
      | undefined) ?? null;
  }

  function getReviewByThread(threadId: string): ReviewRow | null {
    return (db.prepare(`SELECT * FROM reviews WHERE thread_id = ?`).get(threadId) as
      | ReviewRow
      | undefined) ?? null;
  }

  function listFindings(reviewId: string): FindingDto[] {
    const rows = db
      .prepare(`SELECT * FROM findings WHERE review_id = ? ORDER BY ord ASC`)
      .all(reviewId) as FindingRow[];
    return rows.map(toFindingDto);
  }

  function getFinding(findingId: string): FindingRow | null {
    return (db.prepare(`SELECT * FROM findings WHERE id = ?`).get(findingId) as
      | FindingRow
      | undefined) ?? null;
  }

  function requireFinding(findingId: string): FindingRow {
    const row = getFinding(findingId);
    if (row === null) throw new Error(`No finding with id ${findingId}.`);
    return row;
  }

  function touchReview(reviewId: string, patch: Partial<ReviewRow>): void {
    const fields = Object.keys(patch);
    if (fields.length === 0) return;
    db.prepare(
      `UPDATE reviews SET ${fields.map((f) => `${f} = @${f}`).join(", ")}, updated_at = @updated_at
       WHERE id = @id`,
    ).run({ ...patch, id: reviewId, updated_at: nowIso() });
  }

  function announce(): void {
    bb.realtime.publish(CHANGED, { at: nowIso() });
  }

  // -------------------------------------------------------------------------
  // gh plumbing. The server may run with a trimmed PATH, so probe the usual
  // install locations once and remember the winner.
  // -------------------------------------------------------------------------
  let ghPath: string | null = null;
  type GhState = "ready" | "needs_configuration" | "unavailable" | "checking";
  let ghState: GhState = "checking";
  let ghDetail: string | null = "checking gh…";

  async function resolveGh(): Promise<string> {
    if (ghPath !== null) return ghPath;
    for (const candidate of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
      try {
        await runCommand(candidate, ["--version"], 5_000);
        ghPath = candidate;
        return candidate;
      } catch {
        // try the next location
      }
    }
    throw needsConfiguration(`GitHub CLI not found. ${GH_HINT}`);
  }

  async function gh(args: string[], timeoutMs?: number): Promise<string> {
    const { stdout } = await runCommand(await resolveGh(), args, timeoutMs);
    return stdout;
  }

  // `gh auth status` hits the network, so its failure is not by itself a
  // configuration problem. Only two outcomes are: gh missing, and gh present
  // with no credentials at all — which `gh auth token` answers offline.
  // Everything else stays retryable rather than latching the plugin.
  async function probeAuth(): Promise<void> {
    try {
      await gh(["auth", "status", "--hostname", GH_HOST, "--active"], 10_000);
      ghState = "ready";
      ghDetail = null;
      return;
    } catch (error) {
      ghDetail = error instanceof Error ? error.message : String(error);
      if (isNeedsConfigurationError(error)) {
        ghState = "needs_configuration";
        throw error;
      }
    }
    let hasCredentials = true;
    try {
      await gh(["auth", "token", "--hostname", GH_HOST], 5_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hasCredentials = !GH_NO_CREDENTIALS.test(message);
    }
    if (!hasCredentials) {
      ghState = "needs_configuration";
      throw needsConfiguration(`GitHub CLI is not authenticated. ${GH_HINT}`);
    }
    ghState = "unavailable";
    throw new Error(`gh auth status failed (this is usually transient): ${ghDetail}`);
  }

  // Concurrent callers share one in-flight probe instead of spawning duplicate
  // gh processes.
  let authProbe: Promise<void> | null = null;
  function checkAuth(): Promise<void> {
    if (authProbe === null) {
      authProbe = probeAuth().finally(() => {
        authProbe = null;
      });
    }
    return authProbe;
  }

  // -------------------------------------------------------------------------
  // Viewer, teams, repos
  // -------------------------------------------------------------------------
  let viewerCache: { login: string; at: number } | null = null;

  async function getViewer(): Promise<string> {
    if (viewerCache !== null && Date.now() - viewerCache.at < VIEWER_CACHE_MS) {
      return viewerCache.login;
    }
    const login = ghField(await gh(["api", "user"], 15_000), "login");
    if (login === "") throw new Error("could not resolve the gh viewer login");
    viewerCache = { login, at: Date.now() };
    return login;
  }

  let teamCache: { teams: string[]; at: number } | null = null;

  async function getMyTeams(): Promise<string[]> {
    const configured = parseRepoList((await settings.get()).teams ?? "");
    if (configured.length > 0) return configured;
    if (teamCache !== null && Date.now() - teamCache.at < TEAM_CACHE_MS) {
      return teamCache.teams;
    }
    let teams: string[] = [];
    try {
      // Needs the `read:org` scope; without it gh 403s and the team filters
      // simply stay empty rather than breaking the panel.
      const raw = await gh(
        ["api", "--paginate", "/user/teams", "--jq", ".[] | .organization.login + \"/\" + .slug"],
        20_000,
      );
      teams = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => isRepoName(line));
    } catch (error) {
      bb.log.warn(`could not list teams: ${String(error)}`);
    }
    teamCache = { teams, at: Date.now() };
    return teams;
  }

  interface RepoInfo {
    repo: string;
    projectId: string | null;
  }

  let repoCache: { repos: RepoInfo[]; at: number } | null = null;

  async function discoverRepos(force = false): Promise<RepoInfo[]> {
    if (!force && repoCache !== null && Date.now() - repoCache.at < 60_000) {
      return repoCache.repos;
    }
    const byRepo = new Map<string, RepoInfo>();
    try {
      const projects = await bb.sdk.projects.list();
      for (const project of projects) {
        for (const source of project.sources ?? []) {
          if (source.type !== "local_path") continue;
          try {
            const { stdout } = await runCommand(
              "git",
              ["-C", source.path, "remote", "get-url", "origin"],
              5_000,
            );
            const repo = parseGithubRemote(stdout);
            if (repo !== null && !byRepo.has(repo)) {
              byRepo.set(repo, { repo, projectId: project.id });
            }
          } catch {
            // not a git checkout, or no origin — skip it
          }
        }
      }
    } catch (error) {
      bb.log.warn(`project discovery failed: ${String(error)}`);
    }
    for (const repo of parseRepoList((await settings.get()).repos ?? "")) {
      if (!byRepo.has(repo)) byRepo.set(repo, { repo, projectId: null });
    }
    const repos = [...byRepo.values()].sort((a, b) => a.repo.localeCompare(b.repo));
    repoCache = { repos, at: Date.now() };
    return repos;
  }

  async function resolveProjectId(repo: string): Promise<string> {
    const known = (await discoverRepos()).find((info) => info.repo === repo);
    if (known?.projectId != null) return known.projectId;
    const configured = (await settings.get()).defaultProject;
    if (typeof configured === "string" && configured !== "") return configured;
    throw new Error(
      `No BB project is attached to ${repo}. Create a project whose checkout has that ` +
        "origin remote, or set the plugin's default project setting.",
    );
  }

  // -------------------------------------------------------------------------
  // Pull requests
  // -------------------------------------------------------------------------
  /**
   * The stored PR list for a repo. Deliberately has no expiry: the panel shows
   * what you last pulled until you press Refresh, so re-opening the tab is
   * instant and never silently re-runs gh.
   */
  function storedPullRequests(repo: string): { prs: PullRequest[]; fetchedAt: string } | null {
    const row = db.prepare(`SELECT prs, fetched_at FROM pr_cache WHERE repo = ?`).get(repo) as
      | { prs: string; fetched_at: string }
      | undefined;
    if (row === undefined) return null;
    try {
      return { prs: JSON.parse(row.prs) as PullRequest[], fetchedAt: row.fetched_at };
    } catch {
      return null;
    }
  }

  async function fetchPullRequests(
    repo: string,
    force = false,
  ): Promise<{ prs: PullRequest[]; fetchedAt: string }> {
    if (!force) {
      const stored = storedPullRequests(repo);
      if (stored !== null) return stored;
    }
    const raw = await gh(
      ["pr", "list", "-R", repo, "--state", "open", "--limit", "100", "--json", PR_JSON_FIELDS],
      45_000,
    );
    const prs = parsePullRequests(raw, repo);
    const fetchedAt = nowIso();
    db.prepare(
      `INSERT INTO pr_cache (repo, prs, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(repo) DO UPDATE SET prs = excluded.prs, fetched_at = excluded.fetched_at`,
    ).run(repo, JSON.stringify(prs), fetchedAt);
    return { prs, fetchedAt };
  }

  /** Attach this plugin's review state to the wire DTO. */
  function withReviewState(pr: PullRequest): PullRequestDto {
    const review = getReview(reviewIdFor(pr.repo, pr.number));
    const findings = review === null ? [] : listFindings(review.id);
    return {
      ...pr,
      reviewStatus: review === null ? "none" : toReviewDto(review).status,
      openFindings: findings.filter((finding) => finding.state === "open").length,
      postedFindings: findings.filter((finding) => finding.state === "posted").length,
    };
  }

  // -------------------------------------------------------------------------
  // The PR snapshot the review agent reads
  // -------------------------------------------------------------------------
  interface ContextRow {
    snapshot: string;
    diff: string;
    fetched_at: string;
    at_review_start: number;
  }

  function getContext(
    reviewId: string,
  ): { snapshot: PrSnapshot; diff: string; atReviewStart: boolean } | null {
    const row = db.prepare(`SELECT * FROM review_context WHERE review_id = ?`).get(reviewId) as
      | ContextRow
      | undefined;
    if (row === undefined) return null;
    return {
      snapshot: JSON.parse(row.snapshot) as PrSnapshot,
      diff: row.diff,
      atReviewStart: row.at_review_start !== 0,
    };
  }

  /**
   * Fetch the PR once, on the server, and store it. Everything the review
   * agent needs comes from here, so the agent never runs gh: gh is configured
   * and unsandboxed here, and may be neither in the agent's environment.
   */
  async function fetchContext(
    repo: string,
    number: number,
    atReviewStart = true,
  ): Promise<PrSnapshot> {
    const [viewRaw, diffRaw] = await Promise.all([
      gh(["pr", "view", String(number), "-R", repo, "--json", PR_VIEW_JSON_FIELDS], 45_000),
      gh(["pr", "diff", String(number), "-R", repo], 120_000),
    ]);
    const snapshot = parsePrSnapshot(viewRaw);
    // Inline review comments live on a separate endpoint that some repos
    // refuse; losing them is not worth failing the review over.
    try {
      snapshot.reviewComments = parseReviewComments(
        await gh(["api", "--paginate", `repos/${repo}/pulls/${number}/comments`], 45_000),
      );
    } catch (error) {
      bb.log.warn(`could not fetch review comments for ${repo}#${number}: ${String(error)}`);
    }
    db.prepare(
      `INSERT INTO review_context (review_id, snapshot, diff, fetched_at, at_review_start)
       VALUES (@review_id, @snapshot, @diff, @fetched_at, @at_review_start)
       ON CONFLICT(review_id) DO UPDATE SET
         snapshot = @snapshot, diff = @diff, fetched_at = @fetched_at,
         at_review_start = @at_review_start`,
    ).run({
      review_id: reviewIdFor(repo, number),
      snapshot: JSON.stringify(snapshot),
      diff: diffRaw,
      fetched_at: nowIso(),
      at_review_start: atReviewStart ? 1 : 0,
    });
    return snapshot;
  }

  // -------------------------------------------------------------------------
  // Starting a review
  // -------------------------------------------------------------------------
  async function startReview(
    repo: string,
    number: number,
    skillOverride?: string[],
  ): Promise<ReviewDto> {
    requireRepo(repo);
    const config = await settings.get();
    const skills = skillOverride ?? parseSkillList(config.reviewSkills ?? "");
    const reviewId = reviewIdFor(repo, number);
    // Fetch the PR up front, on the server. If GitHub is unreachable there is
    // no point spawning an agent that would have nothing to read.
    const snapshot = await fetchContext(repo, number);
    const title = snapshot.title === "" ? `PR #${number}` : snapshot.title;
    const findingsPath = path.posix.join(
      config.findingsDir === "" ? ".bb/code-review" : config.findingsDir,
      `${repo.replace("/", "-")}-${number}.json`,
    );

    // Re-running a review replaces what has not been acted on and keeps what
    // has: posted comments are history, and dismissals are a decision the user
    // should not have to make twice.
    db.prepare(`DELETE FROM findings WHERE review_id = ? AND state = 'open'`).run(reviewId);
    // Cached file bodies belong to the commit that was reviewed; a re-run may
    // be on a newer one.
    db.prepare(`DELETE FROM review_files WHERE review_id = ?`).run(reviewId);

    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO reviews (id, repo, number, title, status, summary, error, thread_id,
                            findings_path, skills, created_at, updated_at)
       VALUES (@id, @repo, @number, @title, 'queued', '', NULL, NULL, @findings_path,
               @skills, @created_at, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         title = @title, status = 'queued', summary = '', error = NULL, thread_id = NULL,
         findings_path = @findings_path, skills = @skills, updated_at = @updated_at`,
    ).run({
      id: reviewId,
      repo,
      number,
      title,
      findings_path: findingsPath,
      skills: JSON.stringify(skills),
      created_at: timestamp,
      updated_at: timestamp,
    });
    announce();

    const projectId = await resolveProjectId(repo);
    const prompt = buildReviewPrompt({
      repo,
      number,
      title,
      reviewId,
      findingsPath,
      skills,
      extraInstructions: config.reviewInstructions ?? "",
      headSha: snapshot.headSha,
    });
    try {
      const thread = await bb.sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        title: `Review ${repo}#${number}: ${title}`.slice(0, 120),
        prompt,
      });
      touchReview(reviewId, { thread_id: thread.id, status: "running" });
      bb.log.info(`started review thread ${thread.id} for ${reviewId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      touchReview(reviewId, { status: "failed", error: message });
      announce();
      throw error;
    }
    announce();
    const row = getReview(reviewId);
    if (row === null) throw new Error(`review ${reviewId} disappeared`);
    return toReviewDto(row);
  }

  // -------------------------------------------------------------------------
  // Importing the findings file
  // -------------------------------------------------------------------------

  /**
   * `run` executes on the server, but the findings file lives on whichever
   * machine the agent ran on. Resolve that host from the invoking thread and
   * read through bb.sdk.files so a remote checkout is not silently read from
   * the server's own disk.
   */
  async function resolveInvokingHostId(threadId?: string): Promise<string | undefined> {
    if (threadId === undefined) return undefined;
    try {
      const { environmentId } = await bb.sdk.threads.get({ threadId });
      if (environmentId === null) return undefined;
      const { hostId } = await bb.sdk.environments.get({ environmentId });
      return hostId;
    } catch (error) {
      bb.log.warn(`could not resolve invoking host for ${threadId}: ${String(error)}`);
      return undefined;
    }
  }

  function importFindings(reviewId: string, findings: Finding[], summary: string): number {
    const existingPosted = db
      .prepare(`SELECT COUNT(*) AS n FROM findings WHERE review_id = ? AND state != 'open'`)
      .get(reviewId) as { n: number };
    const insert = db.prepare(
      `INSERT INTO findings (id, review_id, ord, file, start_line, end_line, side, severity,
                             category, title, summary, background, problem, suggested_fix,
                             suggested_comment, references_json, draft_comment, state)
       VALUES (@id, @review_id, @ord, @file, @start_line, @end_line, @side, @severity,
               @category, @title, @summary, @background, @problem, @suggested_fix,
               @suggested_comment, @references_json, NULL, 'open')`,
    );
    const write = db.transaction((rows: Finding[]) => {
      db.prepare(`DELETE FROM findings WHERE review_id = ? AND state = 'open'`).run(reviewId);
    // Cached file bodies belong to the commit that was reviewed; a re-run may
    // be on a newer one.
    db.prepare(`DELETE FROM review_files WHERE review_id = ?`).run(reviewId);
      rows.forEach((finding, index) => {
        insert.run({
          id: randomUUID(),
          review_id: reviewId,
          ord: existingPosted.n + index,
          file: finding.file,
          start_line: finding.startLine,
          end_line: finding.endLine,
          side: finding.side,
          severity: finding.severity,
          category: finding.category,
          title: finding.title,
          summary: finding.summary,
          background: finding.background,
          problem: finding.problem,
          suggested_fix: finding.suggestedFix,
          suggested_comment: finding.suggestedComment,
          references_json: JSON.stringify(finding.references),
        });
      });
    });
    const sorted = [...findings].sort(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        a.file.localeCompare(b.file) ||
        (a.startLine ?? 0) - (b.startLine ?? 0),
    );
    write(sorted);
    touchReview(reviewId, { status: "reported", summary, error: null });
    announce();
    return sorted.length;
  }

  // -------------------------------------------------------------------------
  // Posting to GitHub
  // -------------------------------------------------------------------------
  async function headSha(repo: string, number: number): Promise<string> {
    // Deliberately not cached: posting against a stale head SHA is rejected by
    // GitHub, and a review can sit in the panel while the PR keeps moving.
    const raw = await gh(["pr", "view", String(number), "-R", repo, "--json", "headRefOid"], 20_000);
    const sha = ghField(raw, "headRefOid");
    if (sha === "") throw new Error(`could not resolve the head commit of ${repo}#${number}`);
    return sha;
  }

  async function postFinding(
    findingId: string,
    mode: "inline" | "issue",
  ): Promise<FindingDto> {
    const row = requireFinding(findingId);
    const finding = toFindingDto(row);
    if (finding.state === "posted") {
      throw new Error("That comment has already been posted.");
    }
    const review = getReview(finding.reviewId);
    if (review === null) throw new Error(`No review for finding ${findingId}.`);
    const body = effectiveComment(finding);
    if (body.trim() === "") throw new Error("The comment is empty.");

    const inline = mode === "inline" && finding.startLine !== null;
    const raw = await gh(
      buildPostCommentArgs({
        repo: review.repo,
        number: review.number,
        body,
        headSha: inline ? await headSha(review.repo, review.number) : "",
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        side: finding.side,
        mode,
      }),
      30_000,
    );
    const url = ghField(raw, "html_url");

    db.prepare(
      `UPDATE findings SET state = 'posted', comment_url = ?, posted_at = ? WHERE id = ?`,
    ).run(url === "" ? null : url, nowIso(), findingId);
    announce();
    return toFindingDto(requireFinding(findingId));
  }

  // -------------------------------------------------------------------------
  // Discussing a finding
  // -------------------------------------------------------------------------
  async function discussFinding(findingId: string): Promise<string> {
    const row = requireFinding(findingId);
    if (row.discussion_thread_id !== null) {
      // Reuse the existing conversation so "Discuss" is idempotent — unless
      // the thread has since been deleted.
      try {
        await bb.sdk.threads.get({ threadId: row.discussion_thread_id });
        return row.discussion_thread_id;
      } catch {
        db.prepare(`UPDATE findings SET discussion_thread_id = NULL WHERE id = ?`).run(findingId);
      }
    }
    const finding = toFindingDto(row);
    const review = getReview(finding.reviewId);
    if (review === null) throw new Error(`No review for finding ${findingId}.`);
    const projectId = await resolveProjectId(review.repo);
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: { type: "project-default" },
      title: `${review.repo}#${review.number}: ${finding.title}`.slice(0, 120),
      parentThreadId: review.thread_id ?? undefined,
      prompt: buildDiscussionPrompt({
        repo: review.repo,
        number: review.number,
        prTitle: review.title,
        finding: {
          file: finding.file,
          startLine: finding.startLine,
          endLine: finding.endLine,
          title: finding.title,
          background: finding.background,
          problem: finding.problem,
          suggestedFix: finding.suggestedFix,
          suggestedComment: effectiveComment(finding),
        },
      }),
    });
    db.prepare(`UPDATE findings SET discussion_thread_id = ? WHERE id = ?`).run(
      thread.id,
      findingId,
    );
    announce();
    return thread.id;
  }

  // -------------------------------------------------------------------------
  // Review threads that end without submitting
  // -------------------------------------------------------------------------
  bb.events.on("thread.idle", ({ thread }) => {
    const review = getReviewByThread(thread.id);
    if (review === null || review.status !== "running") return;
    touchReview(review.id, {
      status: "failed",
      error:
        "The review thread finished without submitting findings. Open it to see what happened, " +
        "or re-run the review.",
    });
    announce();
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const review = getReviewByThread(thread.id);
    if (review === null || review.status !== "running") return;
    touchReview(review.id, { status: "failed", error: error ?? "The review thread failed." });
    announce();
  });

  // -------------------------------------------------------------------------
  // The code a finding points at
  // -------------------------------------------------------------------------

  /**
   * A file's body at the reviewed commit, cached per review. Fetched from
   * GitHub rather than a checkout because the panel has no worktree, and
   * because the reviewed commit is what the finding's line numbers refer to.
   */
  async function fileContent(
    reviewId: string,
    repo: string,
    sha: string,
    filePath: string,
  ): Promise<{ content: string | null; error: string | null }> {
    const cached = db
      .prepare(`SELECT content, error FROM review_files WHERE review_id = ? AND path = ?`)
      .get(reviewId, filePath) as { content: string | null; error: string | null } | undefined;
    if (cached !== undefined) return cached;

    let content: string | null = null;
    let error: string | null = null;
    try {
      const raw = await gh(
        [
          "api",
          `repos/${repo}/contents/${filePath.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
        ],
        30_000,
      );
      const parsed = JSON.parse(raw) as { content?: unknown; encoding?: unknown };
      if (typeof parsed.content !== "string") {
        error = `${filePath} is not a readable file at ${sha.slice(0, 12)}.`;
      } else {
        content =
          parsed.encoding === "base64"
            ? Buffer.from(parsed.content, "base64").toString("utf8")
            : parsed.content;
      }
    } catch (cause) {
      // A cited file may simply not exist at that commit — the agent may have
      // named it loosely. That is a per-file note, not a failed request.
      const message = cause instanceof Error ? cause.message : String(cause);
      error = /404|not found/i.test(message)
        ? `${filePath} is not in the repository at ${sha.slice(0, 12)}.`
        : message;
    }
    db.prepare(
      `INSERT INTO review_files (review_id, path, content, error, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(review_id, path) DO UPDATE SET
         content = excluded.content, error = excluded.error, fetched_at = excluded.fetched_at`,
    ).run(reviewId, filePath, content, error, nowIso());
    return { content, error };
  }

  /**
   * Every path in the repo at the reviewed commit, cached per review. Fetched
   * only when a citation fails to resolve against the PR's own files, which is
   * the uncommon case.
   */
  async function repoTree(reviewId: string, repo: string, sha: string): Promise<string[]> {
    const cached = db.prepare(`SELECT paths FROM repo_tree WHERE review_id = ?`).get(reviewId) as
      | { paths: string }
      | undefined;
    if (cached !== undefined) return parseJsonArray<string>(cached.paths);
    let paths: string[] = [];
    try {
      const raw = await gh(
        [
          "api",
          `repos/${repo}/git/trees/${sha}?recursive=1`,
          "--jq",
          '[.tree[] | select(.type=="blob") | .path] | join("\n")',
        ],
        45_000,
      );
      paths = raw.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    } catch (error) {
      // Resolution is a convenience; without it a citation just stays as
      // written and reports that it is not in the repo.
      bb.log.warn(`could not read the tree of ${repo}@${sha.slice(0, 12)}: ${String(error)}`);
    }
    db.prepare(
      `INSERT INTO repo_tree (review_id, paths, fetched_at) VALUES (?, ?, ?)
       ON CONFLICT(review_id) DO UPDATE SET paths = excluded.paths, fetched_at = excluded.fetched_at`,
    ).run(reviewId, JSON.stringify(paths), nowIso());
    return paths;
  }

  function pathDigest(filePath: string): string {
    return createHash("sha256").update(filePath).digest("hex");
  }

  async function findingCode(findingId: string, contextLines: number) {
    const row = requireFinding(findingId);
    const finding = toFindingDto(row);
    const review = getReview(finding.reviewId);
    if (review === null) throw new Error(`No review for finding ${findingId}.`);
    // A review from before snapshots existed, or one whose fetch failed, has
    // no stored commit. Fetching it is two gh calls — far cheaper than telling
    // the user to re-run an agent review just to look at code.
    let stored = getContext(finding.reviewId);
    if (stored === null || stored.snapshot.headSha === "") {
      await fetchContext(review.repo, review.number, false);
      stored = getContext(finding.reviewId);
    }
    const snapshot = stored?.snapshot ?? null;
    const sha = snapshot?.headSha ?? "";

    const prPaths = (snapshot?.files ?? []).map((entry) => entry.path);
    // Resolve against the PR's files first; only if something still looks
    // unresolved is the repo-wide tree worth a call.
    const firstPass = findingLocations(
      {
        file: finding.file,
        startLine: finding.startLine,
        endLine: finding.endLine,
        summary: finding.summary,
        background: finding.background,
        problem: finding.problem,
        suggestedFix: finding.suggestedFix,
        references: finding.references,
      },
      (file) => resolveCitedPath(file, prPaths),
    );
    const treePaths = firstPass.some((location) => needsPathResolution(location.file, prPaths))
      ? await repoTree(finding.reviewId, review.repo, sha)
      : [];

    const locations: FindingLocation[] = findingLocations({
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      summary: finding.summary,
      background: finding.background,
      problem: finding.problem,
      suggestedFix: finding.suggestedFix,
      references: finding.references,
    }, (file) => resolveCitedPath(file, prPaths, treePaths));

    const resolved = await Promise.all(
      locations.map(async (location) => {
        const diffUrl = githubPrFileUrl({
          repo: review.repo,
          number: review.number,
          pathDigest: pathDigest(location.file),
          line: location.startLine,
          side: finding.side,
        });
        const base = { ...location, diffUrl, firstLine: 1, lines: [] as string[] };
        if (sha === "") {
          return {
            ...base,
            hasMoreAbove: false,
            hasMoreBelow: false,
            error: "This review has no fetched commit; re-run it to see the code.",
          };
        }
        const { content, error } = await fileContent(
          finding.reviewId,
          review.repo,
          sha,
          location.file,
        );
        if (content === null) {
          return { ...base, hasMoreAbove: false, hasMoreBelow: false, error };
        }
        const all = content.split("\n");
        // No line anchor means the whole file is the subject; show the head of
        // it rather than nothing.
        const start = location.startLine ?? 1;
        const end = location.endLine ?? start;
        const from = Math.max(1, start - contextLines);
        const to = Math.min(all.length, end + contextLines);
        return {
          ...base,
          firstLine: from,
          lines: all.slice(from - 1, to),
          hasMoreAbove: from > 1,
          hasMoreBelow: to < all.length,
          error: null,
        };
      }),
    );
    return {
      prUrl: githubPrUrl(review.repo, review.number),
      headSha: sha,
      // False when the code shown was fetched after the fact, so its line
      // numbers may have moved since the finding was written.
      isReviewedCommit: stored?.atReviewStart ?? false,
      locations: resolved,
    };
  }

  // -------------------------------------------------------------------------
  // Panel state, so re-opening the tab resumes where it left off
  // -------------------------------------------------------------------------
  function readPanelState() {
    const row = db.prepare(`SELECT repo, filter FROM panel_state WHERE id = 1`).get() as
      | { repo: string | null; filter: string | null }
      | undefined;
    if (row === undefined) return { repo: null, filter: null };
    let filter: unknown = null;
    try {
      filter = row.filter === null ? null : JSON.parse(row.filter);
    } catch {
      filter = null;
    }
    const parsed = filterSchema.safeParse(filter);
    return { repo: row.repo, filter: parsed.success ? parsed.data : null };
  }

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------
  bb.rpc.register(rpcContract, {
    async status() {
      const config = await settings.get();
      let viewer: string | null = null;
      try {
        await checkAuth();
        viewer = await getViewer();
      } catch (error) {
        if (ghDetail === null) {
          ghDetail = error instanceof Error ? error.message : String(error);
        }
      }
      const repos = (await discoverRepos()).map((info) => info.repo);
      const myTeams = ghState === "ready" ? await getMyTeams() : [];
      return {
        state: ghState,
        detail: ghDetail,
        viewer,
        repos,
        myTeams,
        skills: parseSkillList(config.reviewSkills ?? ""),
      };
    },

    async listPullRequests({ repo, filter, refresh }) {
      requireRepo(repo);
      await checkAuth();
      const { prs, fetchedAt } = await fetchPullRequests(repo, refresh === true);
      const context = {
        viewer: await getViewer(),
        myTeams: await getMyTeams(),
      };
      const filtered = filterPullRequests(prs, filter, context);
      return {
        fetchedAt,
        pullRequests: filtered
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map(withReviewState),
      };
    },

    // The panel shows issues, not the diff — the diff lives on GitHub, one
    // click away, and the reviewed snapshot is already stored. So this stays a
    // cheap read rather than a per-view `gh pr diff`.
    async getPullRequest({ repo, number }) {
      requireRepo(repo);
      await checkAuth();
      const { prs } = await fetchPullRequests(repo);
      const pr = prs.find((candidate) => candidate.number === number) ?? null;
      const review = getReview(reviewIdFor(repo, number));
      return {
        pullRequest: pr === null ? null : withReviewState(pr),
        review: review === null ? null : toReviewDto(review),
        findings: review === null ? [] : listFindings(review.id),
      };
    },

    async startReview({ repo, number, skills }) {
      await checkAuth();
      return { review: await startReview(repo, number, skills) };
    },

    setFindingComment({ findingId, comment }) {
      const row = requireFinding(findingId);
      // Storing null when the edit matches the suggestion keeps "edited" an
      // honest signal in the UI.
      const draft = comment === row.suggested_comment ? null : comment;
      db.prepare(`UPDATE findings SET draft_comment = ? WHERE id = ?`).run(draft, findingId);
      announce();
      return { finding: toFindingDto(requireFinding(findingId)) };
    },

    setFindingState({ findingId, state }) {
      const row = requireFinding(findingId);
      if (row.state === "posted") throw new Error("That comment has already been posted.");
      db.prepare(`UPDATE findings SET state = ? WHERE id = ?`).run(state, findingId);
      announce();
      return { finding: toFindingDto(requireFinding(findingId)) };
    },

    async postFinding({ findingId, mode }) {
      await checkAuth();
      return { finding: await postFinding(findingId, mode) };
    },

    async discussFinding({ findingId }) {
      return { threadId: await discussFinding(findingId) };
    },

    async getFindingCode({ findingId, context }) {
      await checkAuth();
      return findingCode(findingId, context ?? 3);
    },

    getPanelState() {
      return readPanelState();
    },

    setPanelState({ repo, filter }) {
      db.prepare(
        `INSERT INTO panel_state (id, repo, filter, updated_at) VALUES (1, @repo, @filter, @updated_at)
         ON CONFLICT(id) DO UPDATE SET repo = @repo, filter = @filter, updated_at = @updated_at`,
      ).run({
        repo,
        filter: filter === null ? null : JSON.stringify(filter),
        updated_at: nowIso(),
      });
      return readPanelState();
    },
  });

  // -------------------------------------------------------------------------
  // CLI — how the review agent reports back
  // -------------------------------------------------------------------------
  const usage = [
    "Usage:",
    "  bb code-review context --review <review-id> [--json]",
    "  bb code-review diff    --review <review-id> [--file <path>]",
    "  bb code-review files   --review <review-id>",
    "  bb code-review schema",
    "  bb code-review submit  --review <review-id> --file <path-to-findings.json>",
    "",
    'A review id looks like "owner/repo#123". The PR is fetched when the review',
    "starts and served from here, so reviewing needs no network access of its own.",
  ].join("\n");

  function unknownReview(reviewId: string): string {
    return (
      `No review with id ${reviewId}. Start one from the Code Review panel; ` +
      "the id is in the prompt that asked for this review."
    );
  }

  function noSnapshot(reviewId: string): string {
    return (
      `No fetched pull request for ${reviewId}. Re-run the review from the Code ` +
      "Review panel so the plugin can fetch it again."
    );
  }

  /** Trim to the CLI output budget, saying so rather than being rejected. */
  function clamp(text: string): string {
    if (Buffer.byteLength(text, "utf8") <= CLI_OUTPUT_BUDGET) return text;
    return `${text.slice(0, CLI_OUTPUT_BUDGET)}\n\n[truncated — this file's patch is too large to print in full]`;
  }

  function readFlag(argv: string[], name: string): string | null {
    const index = argv.indexOf(`--${name}`);
    if (index !== -1) return argv[index + 1] ?? null;
    const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
    return inline === undefined ? null : inline.slice(name.length + 3);
  }

  bb.cli.register({
    name: "code-review",
    summary: "Report pull request review findings back to the Code Review panel",
    commands: [
      {
        name: "context",
        summary:
          "Print the PR's description, discussion, and changed files (no network needed)",
        usage: "bb code-review context --review <owner/repo#123> [--json]",
      },
      {
        name: "diff",
        summary: "Print the PR's diff, or one file of it with --file",
        usage: "bb code-review diff --review <owner/repo#123> [--file <path>]",
      },
      {
        name: "files",
        summary: "List the PR's changed files",
        usage: "bb code-review files --review <owner/repo#123>",
      },
      {
        name: "schema",
        summary: "Print the JSON schema a findings file must match",
        usage: "bb code-review schema",
      },
      {
        name: "submit",
        summary: "Submit a findings JSON file for a review",
        usage: "bb code-review submit --review <owner/repo#123> --file <path>",
      },
    ],
    async run(argv, ctx) {
      const [command] = argv;
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };

        case "schema":
          return { exitCode: 0, stdout: FINDINGS_SCHEMA_TEXT };

        case "context": {
          const reviewId = readFlag(argv, "review");
          if (reviewId === null) return { exitCode: 1, stderr: usage };
          const review = getReview(reviewId);
          if (review === null) return { exitCode: 1, stderr: unknownReview(reviewId) };
          if (argv.includes("--json")) {
            return { exitCode: 0, stdout: JSON.stringify(toReviewDto(review), null, 2) };
          }
          const context = getContext(reviewId);
          if (context === null) return { exitCode: 1, stderr: noSnapshot(reviewId) };
          return { exitCode: 0, stdout: formatContext(reviewId, context.snapshot) };
        }

        case "files": {
          const reviewId = readFlag(argv, "review");
          if (reviewId === null) return { exitCode: 1, stderr: usage };
          const context = getContext(reviewId);
          if (context === null) return { exitCode: 1, stderr: noSnapshot(reviewId) };
          const files = context.snapshot.files;
          return {
            exitCode: 0,
            stdout:
              files.length === 0
                ? "This pull request changes no files."
                : files
                    .map((file) => `${file.path}  +${file.additions} -${file.deletions}`)
                    .join("\n"),
          };
        }

        case "diff": {
          const reviewId = readFlag(argv, "review");
          if (reviewId === null) return { exitCode: 1, stderr: usage };
          const context = getContext(reviewId);
          if (context === null) return { exitCode: 1, stderr: noSnapshot(reviewId) };
          const wanted = readFlag(argv, "file");
          const patches: FilePatch[] = splitUnifiedDiff(context.diff);
          if (wanted !== null) {
            const match = patches.find((file) => file.path === wanted);
            if (match === undefined) {
              return {
                exitCode: 1,
                stderr: [
                  `${wanted} is not in this pull request's diff. Changed files:`,
                  ...patches.map((file) => `  ${file.path}`),
                ].join("\n"),
              };
            }
            // One pathological file still beats an atomic over-size rejection
            // that would tell the agent nothing at all.
            return { exitCode: 0, stdout: clamp(match.patch) };
          }
          if (Buffer.byteLength(context.diff, "utf8") > CLI_OUTPUT_BUDGET) {
            return { exitCode: 0, stdout: formatFileList(reviewId, patches) };
          }
          return { exitCode: 0, stdout: context.diff };
        }

        case "submit": {
          const reviewId = readFlag(argv, "review");
          const file = readFlag(argv, "file");
          if (reviewId === null || file === null) return { exitCode: 1, stderr: usage };
          const review = getReview(reviewId);
          if (review === null) {
            return { exitCode: 1, stderr: unknownReview(reviewId) };
          }
          const hostId = await resolveInvokingHostId(ctx.threadId);
          const absolute = path.isAbsolute(file)
            ? file
            : path.resolve(ctx.cwd ?? ".", file);
          let raw: string;
          try {
            const result = await bb.sdk.files.read({ hostId, path: absolute });
            raw =
              result.contentEncoding === "base64"
                ? Buffer.from(result.content, "base64").toString("utf8")
                : result.content;
          } catch (error) {
            return {
              exitCode: 1,
              stderr: `Could not read ${absolute}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            };
          }
          const { report, errors } = parseReport(raw);
          if (report === null) {
            return {
              exitCode: 1,
              stderr:
                `${absolute} is not a valid findings file — ${errors.join("; ")}\n\n` +
                `Expected shape:\n${FINDINGS_SCHEMA_TEXT}`,
            };
          }
          touchReview(reviewId, { findings_path: absolute });
          const count = importFindings(reviewId, report.findings, report.summary);
          const lines = [
            `Submitted ${count} finding${count === 1 ? "" : "s"} for ${reviewId}.`,
            ...errors.map((problem) => `Warning: ${problem}`),
          ];
          // Dropped findings are a warning, not a failure: the rest are in.
          return { exitCode: 0, stdout: lines.join("\n") };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  // A gh probe at load turns a missing or unauthenticated gh into a visible
  // needs-configuration state instead of a first-click error.
  void checkAuth().catch((error) => {
    if (isNeedsConfigurationError(error)) {
      bb.status.needsConfiguration(error.message);
    } else {
      bb.log.warn(`gh probe failed: ${String(error)}`);
    }
  });

  bb.log.info("loaded");
}
