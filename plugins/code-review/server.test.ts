import { createHash } from "node:crypto";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin, { type FindingDto, type ReviewDto } from "./server";

const REPO = "acme/app";
const REVIEW_ID = `${REPO}#7`;

const FINDING = {
  file: "src/a.ts",
  startLine: 10,
  endLine: 12,
  side: "RIGHT",
  severity: "high",
  category: "correctness",
  title: "Off by one",
  background: "b",
  problem: "the loop runs one past the end",
  suggestedFix: "f",
  suggestedComment: "Please fix the bound here.",
};

const PR = {
  number: 7,
  title: "Add a thing",
  author: { login: "dan" },
  url: "https://github.com/acme/app/pull/7",
  updatedAt: "2026-01-02T00:00:00Z",
  isDraft: false,
  additions: 3,
  deletions: 1,
  changedFiles: 1,
  headRefOid: "sha7",
  baseRefName: "main",
  headRefName: "feature",
  labels: [],
  reviewRequests: [{ __typename: "User", login: "robennals" }],
};

interface ShellCall {
  file: string;
  args: string[];
  stdin?: string;
}

/** The parts of a spawn call these tests assert on. */
interface SpawnRecord {
  prompt: string;
  projectId: string;
  title: string;
  parentThreadId: string | null;
}

/**
 * A fake host with gh, the file the agent "wrote", and thread spawning all
 * driven from the test. gh answers by matching the leading argv, so each test
 * only stubs the calls it cares about and an unexpected call fails loudly.
 */
async function makeHost(
  options: {
    files?: Record<string, string>;
    prs?: unknown[];
    ghOverrides?: Record<string, string>;
    ghMissing?: boolean;
    /** argv prefix -> the message that gh call should fail with. */
    ghFailures?: Record<string, string>;
    spawnError?: string;
  } = {},
) {
  const calls: ShellCall[] = [];
  const spawned: SpawnRecord[] = [];
  const files = options.files ?? {};
  /** Mutable, so a test can break a gh call after the review has already run. */
  const failures: Record<string, string> = { ...options.ghFailures };

  const gh: Record<string, string> = {
    "--version": "gh version 2.83.1",
    "auth status": "Logged in",
    "auth token": "gho_x",
    "api user": JSON.stringify({ login: "robennals" }),
    "api --paginate": "acme/core\nacme/infra",
    "pr list": JSON.stringify(options.prs ?? [PR]),
    "pr view": JSON.stringify({
      title: "Add a thing",
      body: "Why this change exists.",
      author: { login: "dan" },
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefName: "feature",
      headRefOid: "sha7",
      comments: [{ author: { login: "kim" }, body: "Looks good.", createdAt: "2026-01-01" }],
      files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
    }),
    "api --paginate repos": JSON.stringify([
      { path: "src/a.ts", line: 11, user: { login: "sam" }, body: "off by one" },
    ]),
    // A hunk covering lines 1-20 of the new file, so the fixtures' anchors
    // (src/a.ts:10-12) are inside the diff the way a real finding's would be.
    "pr diff":
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,20 +1,20 @@\n-a\n+b",
    "api -X": JSON.stringify({ html_url: "https://github.com/acme/app/pull/7#c1" }),
    // The pending-review lookup and the add-comment mutation are both
    // `gh api graphql`; key them by the operation so they can differ.
    "api graphql -f query=query": "",
    "api graphql -f query=mutation": JSON.stringify({
      data: {
        addPullRequestReviewThread: {
          thread: { comments: { nodes: [{ url: "https://github.com/acme/app/pull/7#d1" }] } },
        },
      },
    }),
    "api repos/acme/app/git/trees": "vendor/outside.ts\nsrc/a.ts\nsrc/other.ts\nsrc/ref.ts",
    "api repos/acme/app/contents": JSON.stringify({
      encoding: "base64",
      content: Buffer.from(
        Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"),
        "utf8",
      ).toString("base64"),
    }),
    ...options.ghOverrides,
  };

  const { bb, harness } = createFakePluginHost({
    pluginId: "code-review",
    settings: { defaultProject: "proj_test", reviewSkills: "code-review", repos: REPO },
    sdk: {
      projects: { list: async () => [] },
      threads: {
        spawn: async (args) => {
          if (options.spawnError !== undefined) throw new Error(options.spawnError);
          spawned.push({
            prompt: args.prompt ?? "",
            projectId: args.projectId,
            title: args.title ?? "",
            parentThreadId: args.parentThreadId ?? null,
          });
          return makeThreadResponse({ id: `thr_${spawned.length}` });
        },
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, environmentId: null }),
      },
      files: {
        read: async ({ path }: { path: string }) => {
          const content = files[path];
          if (content === undefined) throw new Error(`ENOENT: ${path}`);
          return { content, contentEncoding: "utf8", sha256: "x", sizeBytes: content.length };
        },
      },
    },
  });

  await plugin(bb, {
    async runCommand(file, args, _timeoutMs, stdin) {
      calls.push({ file, args, stdin });
      if (options.ghMissing === true) throw new Error("spawn gh ENOENT");
      const joined = args.join(" ");
      const failure = Object.keys(failures).find((prefix) => joined.startsWith(prefix));
      if (failure !== undefined) {
        throw new Error(`gh ${joined} failed: ${failures[failure]}`);
      }
      const key = Object.keys(gh)
        .sort((a, b) => b.length - a.length)
        .find((prefix) => joined.startsWith(prefix));
      if (key === undefined) throw new Error(`unstubbed command: ${file} ${joined}`);
      return { stdout: gh[key] as string, stderr: "" };
    },
  });

  const call = <T>(method: string, input?: unknown) =>
    harness.behavior.callRpc(method, input) as Promise<T>;

  const submit = (file = "/w/f.json") =>
    harness.behavior.runCli(["submit", "--review", REVIEW_ID, "--file", file], { cwd: "/w" });

  const findings = async () =>
    (await call<{ findings: FindingDto[] }>("getPullRequest", { repo: REPO, number: 7 })).findings;

  const review = async () =>
    (await call<{ review: ReviewDto }>("getPullRequest", { repo: REPO, number: 7 })).review;

  return { bb, harness, calls, spawned, failures, call, submit, findings, review };
}

type Host = Awaited<ReturnType<typeof makeHost>>;

const report = (entries: unknown[] = [FINDING], summary = "looks ok") =>
  JSON.stringify({ summary, findings: entries });

/** Start a review and hand its findings file in, the way a review thread does. */
async function runReview(host: Host): Promise<FindingDto[]> {
  await host.call("startReview", { repo: REPO, number: 7 });
  const result = await host.submit();
  expect(result.exitCode, result.stderr).toBe(0);
  return host.findings();
}

describe("status", () => {
  it("reports gh ready, the viewer, the repos, and the teams", async () => {
    const { call } = await makeHost();
    const status = await call<{
      state: string;
      viewer: string | null;
      repos: string[];
      myTeams: string[];
      skills: string[];
    }>("status", null);
    expect(status.state).toBe("ready");
    expect(status.viewer).toBe("robennals");
    expect(status.repos).toEqual([REPO]);
    expect(status.myTeams).toEqual(["acme/core", "acme/infra"]);
    expect(status.skills).toEqual(["code-review"]);
  });

  it("degrades to needs-configuration when gh is not installed", async () => {
    const { call, harness } = await makeHost({ ghMissing: true });
    const status = await call<{ state: string; repos: string[] }>("status", null);
    expect(status.state).toBe("needs_configuration");
    // The repo list still comes from settings, so the panel explains itself.
    expect(status.repos).toEqual([REPO]);
    expect(harness.needsConfigurationMessages.join(" ")).toContain("GitHub CLI not found");
  });

  it("stays retryable when gh has credentials but the API is unreachable", async () => {
    // A network blip is not a configuration problem: latching here would make
    // the panel need a manual reload once the network came back.
    const { call, harness } = await makeHost({
      ghFailures: { "auth status": "network is unreachable" },
    });
    const status = await call<{ state: string; detail: string | null }>("status", null);
    expect(status.state).toBe("unavailable");
    expect(status.detail).toContain("network is unreachable");
    expect(harness.needsConfigurationMessages).toEqual([]);
  });

  it("needs configuration when gh is installed but holds no credentials", async () => {
    const { call, harness } = await makeHost({
      ghFailures: { "auth status": "not logged in", "auth token": "no oauth token found" },
    });
    const status = await call<{ state: string }>("status", null);
    expect(status.state).toBe("needs_configuration");
    expect(harness.needsConfigurationMessages.join(" ")).toContain("not authenticated");
  });

  it("leaves the team filters empty rather than failing without the read:org scope", async () => {
    const { call } = await makeHost({
      ghOverrides: { "api --paginate": "" },
    });
    const status = await call<{ state: string; myTeams: string[] }>("status", null);
    expect(status.state).toBe("ready");
    expect(status.myTeams).toEqual([]);
  });
});

describe("listPullRequests", () => {
  const teamPr = { ...PR, number: 8, reviewRequests: [{ __typename: "Team", slug: "acme/core" }] };
  const nobodyPr = { ...PR, number: 9, reviewRequests: [] };

  it("filters by who was asked to review", async () => {
    const { call } = await makeHost({ prs: [PR, teamPr, nobodyPr] });
    const numbers = async (filter: unknown) =>
      (
        await call<{ pullRequests: Array<{ number: number }> }>("listPullRequests", {
          repo: REPO,
          filter,
        })
      ).pullRequests
        .map((pr) => pr.number)
        .sort();

    expect(await numbers({ kind: "mine" })).toEqual([7]);
    expect(await numbers({ kind: "my-teams" })).toEqual([8]);
    expect(await numbers({ kind: "team", teamSlug: "acme/core" })).toEqual([8]);
    expect(await numbers({ kind: "all" })).toEqual([7, 8, 9]);
  });

  it("carries this plugin's review state onto each row", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    await runReview(host);
    const { pullRequests } = await host.call<{
      pullRequests: Array<{ reviewStatus: string; openFindings: number; postedFindings: number }>;
    }>("listPullRequests", { repo: REPO, filter: { kind: "all" }, refresh: true });
    expect(pullRequests[0]?.reviewStatus).toBe("reported");
    expect(pullRequests[0]?.openFindings).toBe(1);
    expect(pullRequests[0]?.postedFindings).toBe(0);
  });

  it("rejects a repo that is not owner/repo", async () => {
    const { call } = await makeHost();
    await expect(
      call("listPullRequests", { repo: "not-a-repo", filter: { kind: "all" } }),
    ).rejects.toThrow(/expected owner\/repo/);
  });

  it("only calls gh when the user asks, however long it has been", async () => {
    // The list is what you last pulled until you press Refresh: re-opening the
    // panel must never silently re-run gh.
    const { call, calls } = await makeHost();
    const listCalls = () =>
      calls.filter((entry) => entry.args[0] === "pr" && entry.args[1] === "list").length;

    await call("listPullRequests", { repo: REPO, filter: { kind: "all" } });
    const afterFirst = listCalls();
    expect(afterFirst).toBe(1);

    for (let i = 0; i < 5; i += 1) {
      await call("listPullRequests", { repo: REPO, filter: { kind: "all" } });
    }
    expect(listCalls()).toBe(afterFirst);

    await call("listPullRequests", { repo: REPO, filter: { kind: "all" }, refresh: true });
    expect(listCalls()).toBe(afterFirst + 1);
  });

  it("reports when the list was last pulled", async () => {
    const { call } = await makeHost();
    const first = await call<{ fetchedAt: string }>("listPullRequests", {
      repo: REPO,
      filter: { kind: "all" },
    });
    expect(Number.isNaN(Date.parse(first.fetchedAt))) .toBe(false);

    const cached = await call<{ fetchedAt: string }>("listPullRequests", {
      repo: REPO,
      filter: { kind: "all" },
    });
    // A cached read reports the original fetch time, not "now".
    expect(cached.fetchedAt).toBe(first.fetchedAt);
  });

  it("stores the list in the plugin database, not just in memory", async () => {
    // Durability is the point: the panel must survive a reload or a restart.
    // The fake host closes every database handle on reload, so this asserts
    // the row is on disk; the reload itself is verified against a live server.
    const host = await makeHost();
    await host.call("listPullRequests", { repo: REPO, filter: { kind: "all" } });
    const row = host.bb.storage
      .database()
      .prepare(`SELECT prs, fetched_at FROM pr_cache WHERE repo = ?`)
      .get(REPO) as { prs: string; fetched_at: string } | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row?.prs ?? "[]")).toHaveLength(1);
    expect(Number.isNaN(Date.parse(row?.fetched_at ?? ""))).toBe(false);
  });

  it("still reflects review state changes without re-fetching the list", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    await host.call("listPullRequests", { repo: REPO, filter: { kind: "all" } });
    const before = host.calls.filter((entry) => entry.args[1] === "list").length;
    await runReview(host);
    const after = await host.call<{
      pullRequests: Array<{ reviewStatus: string; openFindings: number }>;
    }>("listPullRequests", { repo: REPO, filter: { kind: "all" } });
    expect(after.pullRequests[0]?.reviewStatus).toBe("reported");
    expect(after.pullRequests[0]?.openFindings).toBe(1);
    expect(host.calls.filter((entry) => entry.args[1] === "list").length).toBe(before);
  });
});

describe("getPullRequest", () => {
  it("is a cheap read: no diff fetch, because the panel shows issues", async () => {
    // The diff lives on GitHub and the reviewed snapshot is already stored, so
    // viewing a PR must not cost a `gh pr diff` every time.
    const host = await makeHost();
    const before = host.calls.filter((entry) => entry.args.join(" ").startsWith("pr diff")).length;
    const detail = await host.call<{
      pullRequest: { title: string } | null;
      review: ReviewDto | null;
    }>("getPullRequest", { repo: REPO, number: 7 });
    expect(detail.pullRequest?.title).toBe("Add a thing");
    expect(detail.review).toBeNull();
    const after = host.calls.filter((entry) => entry.args.join(" ").startsWith("pr diff")).length;
    expect(after).toBe(before);
  });

  it("returns the PR's findings once a review has reported", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    await runReview(host);
    const detail = await host.call<{ review: ReviewDto; findings: FindingDto[] }>(
      "getPullRequest",
      { repo: REPO, number: 7 },
    );
    expect(detail.review.status).toBe("reported");
    expect(detail.findings).toHaveLength(1);
  });
});

describe("startReview", () => {
  it("spawns a thread carrying the review id, findings path, and skills", async () => {
    const { call, spawned } = await makeHost();
    const { review } = await call<{ review: ReviewDto }>("startReview", { repo: REPO, number: 7 });
    expect(review.id).toBe(REVIEW_ID);
    expect(review.status).toBe("running");
    expect(review.threadId).toBe("thr_1");
    expect(review.skills).toEqual(["code-review"]);

    const prompt = spawned[0]?.prompt ?? "";
    expect(prompt).toContain(`bb code-review submit --review ${REVIEW_ID}`);
    expect(prompt).toContain(review.findingsPath as string);
    expect(prompt).toContain("Do NOT post anything to GitHub");
    expect(spawned[0]?.projectId).toBe("proj_test");
  });

  it("honours a per-run skill override", async () => {
    const { call, spawned } = await makeHost();
    const { review } = await call<{ review: ReviewDto }>("startReview", {
      repo: REPO,
      number: 7,
      skills: ["rob-review", "security-review"],
    });
    expect(review.skills).toEqual(["rob-review", "security-review"]);
    expect(spawned[0]?.prompt).toContain("`security-review` skill");
  });

  it("explains how to fix it when no BB project is attached to the repo", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "code-review",
      // No defaultProject, and no project whose checkout points at the repo.
      settings: { repos: REPO },
      sdk: { projects: { list: async () => [] } },
    });
    await plugin(bb, {
      async runCommand(_file, args) {
        const joined = args.join(" ");
        if (joined.startsWith("pr list")) return { stdout: JSON.stringify([PR]), stderr: "" };
        if (joined.startsWith("pr view")) {
          return { stdout: JSON.stringify({ title: "Add a thing", headRefOid: "sha7" }), stderr: "" };
        }
        if (joined.startsWith("pr diff")) return { stdout: "", stderr: "" };
        if (joined.startsWith("api user")) {
          return { stdout: JSON.stringify({ login: "robennals" }), stderr: "" };
        }
        return { stdout: "[]", stderr: "" };
      },
    });
    await expect(
      harness.behavior.callRpc("startReview", { repo: REPO, number: 7 }),
    ).rejects.toThrow(/No BB project is attached to acme\/app/);
  });

  it("marks the review failed instead of leaving it stuck when the spawn fails", async () => {
    const host = await makeHost({ spawnError: "no provider available" });
    await expect(host.call("startReview", { repo: REPO, number: 7 })).rejects.toThrow(
      /no provider available/,
    );
    const review = await host.review();
    expect(review.status).toBe("failed");
    expect(review.error).toContain("no provider available");
  });
});

describe("submitting findings", () => {
  it("imports the file the agent wrote and marks the review reported", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const findings = await runReview(host);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe("Off by one");
    expect(findings[0]?.startLine).toBe(10);
    expect(findings[0]?.endLine).toBe(12);
    expect(findings[0]?.state).toBe("open");
    expect(findings[0]?.draftComment).toBeNull();

    const review = await host.review();
    expect(review.status).toBe("reported");
    expect(review.summary).toBe("looks ok");
  });

  it("resolves a relative --file against the invoking cwd", async () => {
    const host = await makeHost({ files: { "/w/out/f.json": report() } });
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.submit("out/f.json");
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("Submitted 1 finding");
  });

  it("sorts findings by severity, worst first", async () => {
    const host = await makeHost({
      files: {
        "/w/f.json": report([
          { ...FINDING, severity: "nit", title: "N" },
          { ...FINDING, severity: "blocker", title: "B" },
          { ...FINDING, severity: "medium", title: "M" },
        ]),
      },
    });
    expect((await runReview(host)).map((finding) => finding.title)).toEqual(["B", "M", "N"]);
  });

  it("imports the good findings and warns about a bad one", async () => {
    const host = await makeHost({
      files: { "/w/f.json": report([FINDING, { file: "only-a-path.ts" }]) },
    });
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.submit();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Submitted 1 finding");
    expect(result.stdout).toContain("Warning: finding 2 dropped");
  });

  it("rejects a file that is not a findings report, and prints the schema back", async () => {
    const host = await makeHost({ files: { "/w/f.json": "not json at all" } });
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.submit();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not a valid findings file");
    expect(result.stderr).toContain('"suggestedComment"');
  });

  it("accepts an empty findings array as a clean review", async () => {
    const host = await makeHost({ files: { "/w/f.json": report([], "nothing to flag") } });
    expect(await runReview(host)).toEqual([]);
    expect((await host.review()).status).toBe("reported");
  });
});

describe("paths in a submitted report", () => {
  it("rejects a bare filename and names the file it probably meant", async () => {
    const host = await makeHost({
      files: {
        "/w/f.json": report([{ ...FINDING, file: "a.ts" }]),
      },
    });
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.submit();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("does not name a real file");
    expect(result.stderr).toContain("finding 1, file: a.ts");
    expect(result.stderr).toContain("did you mean src/a.ts?");
    // Nothing is imported, so the agent fixes and resubmits.
    expect(await host.findings()).toEqual([]);
  });

  it("rejects a bad path inside references, naming the entry", async () => {
    const host = await makeHost({
      files: {
        "/w/f.json": report([
          {
            ...FINDING,
            references: [{ file: "nope.ts", startLine: 1, endLine: 1, note: "n" }],
          },
        ]),
      },
    });
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.submit();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("references[0].file: nope.ts");
    expect(result.stderr).toContain("no file with that name exists");
  });

  it("lists every candidate when a name is genuinely ambiguous", async () => {
    const host = await makeHost({
      ghOverrides: { "api repos/acme/app/git/trees": "a/dup.ts\nb/dup.ts\nsrc/a.ts" },
      files: { "/w/f.json": report([{ ...FINDING, file: "dup.ts" }]) },
    });
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.submit();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("could be: a/dup.ts, b/dup.ts");
  });

  it("accepts full repo-relative paths", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.submit();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await host.findings()).toHaveLength(1);
  });

  it("does not block a submit when the repo tree cannot be read", async () => {
    // Validation is a guard rail, not a gate: losing a whole review because a
    // tree lookup failed would be worse than an unresolved path.
    const host = await makeHost({
      ghFailures: { "api repos/acme/app/git/trees": "500" },
      files: { "/w/f.json": report([{ ...FINDING, file: "a.ts" }]) },
    });
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.submit();
    expect(result.exitCode, result.stderr).toBe(0);
  });

  it("still accepts an empty report without a tree lookup", async () => {
    const host = await makeHost({ files: { "/w/f.json": report([]) } });
    await host.call("startReview", { repo: REPO, number: 7 });
    expect((await host.submit()).exitCode).toBe(0);
    expect(host.calls.filter((entry) => entry.args.join(" ").includes("/git/trees/"))).toEqual([]);
  });
});

describe("re-running a review", () => {
  it("replaces untouched findings and keeps the ones already posted", async () => {
    const host = await makeHost({
      files: { "/w/f.json": report([FINDING, { ...FINDING, title: "Second", startLine: 20 }]) },
    });
    const first = await runReview(host);
    expect(first).toHaveLength(2);
    await host.call("postFinding", { findingId: first[0]?.id, mode: "inline" });

    await host.call("startReview", { repo: REPO, number: 7 });
    expect((await host.submit()).exitCode).toBe(0);

    const findings = await host.findings();
    const posted = findings.filter((finding) => finding.state === "posted");
    const open = findings.filter((finding) => finding.state === "open");
    expect(posted).toHaveLength(1);
    expect(posted[0]?.id).toBe(first[0]?.id);
    // Both findings come back fresh; the posted one is not duplicated away.
    expect(open).toHaveLength(2);
  });

  it("keeps a dismissal across a re-run", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    await host.call("setFindingState", { findingId: finding?.id, state: "dismissed" });

    await host.call("startReview", { repo: REPO, number: 7 });
    expect((await host.submit()).exitCode).toBe(0);
    const findings = await host.findings();
    expect(findings.filter((entry) => entry.state === "dismissed")).toHaveLength(1);
  });
});

describe("editing, posting, and dismissing", () => {
  it("stores an edit and clears it when it matches the suggestion again", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    const edited = await host.call<{ finding: FindingDto }>("setFindingComment", {
      findingId: finding?.id,
      comment: "My own wording.",
    });
    expect(edited.finding.draftComment).toBe("My own wording.");

    const reverted = await host.call<{ finding: FindingDto }>("setFindingComment", {
      findingId: finding?.id,
      comment: FINDING.suggestedComment,
    });
    // Back to the suggestion, so the panel should stop calling it edited.
    expect(reverted.finding.draftComment).toBeNull();
  });

  it("posts the edited comment, not the original suggestion", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    await host.call("setFindingComment", { findingId: finding?.id, comment: "Edited text." });
    const posted = await host.call<{ finding: FindingDto }>("postFinding", {
      findingId: finding?.id,
      mode: "inline",
    });
    expect(posted.finding.state).toBe("posted");
    expect(posted.finding.commentUrl).toBe("https://github.com/acme/app/pull/7#c1");

    const apiCall = host.calls.find((entry) => entry.args.includes("-X"));
    expect(apiCall?.args).toContain("body=Edited text.");
    expect(apiCall?.args).toContain("repos/acme/app/pulls/7/comments");
    // The head SHA is re-read at post time rather than reused from the listing.
    expect(apiCall?.args).toContain("commit_id=sha7");
  });

  it("posts a general PR comment when asked for one", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    await host.call("postFinding", { findingId: finding?.id, mode: "issue" });
    const apiCall = host.calls.find((entry) => entry.args.includes("-X"));
    expect(apiCall?.args).toContain("repos/acme/app/issues/7/comments");
  });

  it("refuses to post the same finding twice", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    await host.call("postFinding", { findingId: finding?.id, mode: "inline" });
    await expect(
      host.call("postFinding", { findingId: finding?.id, mode: "inline" }),
    ).rejects.toThrow(/already been posted/);
  });

  it("refuses to post an empty comment", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    await host.call("setFindingComment", { findingId: finding?.id, comment: "   " });
    await expect(
      host.call("postFinding", { findingId: finding?.id, mode: "inline" }),
    ).rejects.toThrow(/comment is empty/);
  });

  it("dismisses and restores, but will not dismiss something already posted", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    const dismissed = await host.call<{ finding: FindingDto }>("setFindingState", {
      findingId: finding?.id,
      state: "dismissed",
    });
    expect(dismissed.finding.state).toBe("dismissed");
    await host.call("setFindingState", { findingId: finding?.id, state: "open" });
    await host.call("postFinding", { findingId: finding?.id, mode: "inline" });
    await expect(
      host.call("setFindingState", { findingId: finding?.id, state: "dismissed" }),
    ).rejects.toThrow(/already been posted/);
  });

  it("reports an unknown finding id rather than failing silently", async () => {
    const { call } = await makeHost();
    await expect(call("setFindingComment", { findingId: "nope", comment: "x" })).rejects.toThrow(
      /No finding with id nope/,
    );
  });
});

describe("posting while a review is already open on GitHub", () => {
  const PENDING_ID = "PRR_abc";
  /** gh --jq reduces the pending-review query to the id, or empty. */
  const withPending = (overrides: Record<string, string> = {}) => ({
    "api graphql -f query=query": PENDING_ID,
    ...overrides,
  });

  it("adds the comment to the pending review instead of failing", async () => {
    // GitHub refuses a standalone review comment while the viewer has an
    // unsubmitted review: "one pending review per pull request".
    const host = await makeHost({
      files: { "/w/f.json": report() },
      ghOverrides: withPending(),
    });
    const [finding] = await runReview(host);
    const posted = await host.call<{ finding: FindingDto }>("postFinding", {
      findingId: finding?.id,
      mode: "inline",
    });
    expect(posted.finding.state).toBe("posted");
    expect(posted.finding.postedAs).toBe("pending-review");

    const mutation = host.calls.find((entry) => entry.args.join(" ").includes("addPullRequestReviewThread"));
    expect(mutation).toBeDefined();
    expect(mutation?.args).toContain(`reviewId=${PENDING_ID}`);
    expect(mutation?.args).toContain("path=src/a.ts");
    expect(mutation?.args).toContain("line=12");
    expect(mutation?.args).toContain("startLine=10");
    // The standalone create-comment endpoint must not be attempted at all.
    // (Reading that same path is how the snapshot fetches review comments, so
    // match the POST specifically.)
    const postedStandalone = host.calls.some(
      (entry) =>
        entry.args.includes("-X") &&
        entry.args.includes("POST") &&
        entry.args.includes("repos/acme/app/pulls/7/comments"),
    );
    expect(postedStandalone).toBe(false);
  });

  it("omits the range arguments for a single-line comment", async () => {
    const host = await makeHost({
      files: { "/w/f.json": report([{ ...FINDING, startLine: 10, endLine: 10 }]) },
      ghOverrides: withPending(),
    });
    const [finding] = await runReview(host);
    await host.call("postFinding", { findingId: finding?.id, mode: "inline" });
    const mutation = host.calls.find((entry) => entry.args.join(" ").includes("addPullRequestReviewThread"));
    expect(mutation?.args.some((arg) => arg.startsWith("startLine="))).toBe(false);
  });

  it("uses the ordinary endpoint when there is no pending review", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    const posted = await host.call<{ finding: FindingDto }>("postFinding", {
      findingId: finding?.id,
      mode: "inline",
    });
    expect(posted.finding.postedAs).toBe("comment");
    expect(
      host.calls.some(
        (entry) =>
          entry.args.includes("-X") &&
          entry.args.includes("POST") &&
          entry.args.includes("repos/acme/app/pulls/7/comments"),
      ),
    ).toBe(true);
  });

it("starts a pending review when asked and there is none", async () => {
    // The reviewer wants one draft shared with the GitHub UI, so the plugin
    // has to be able to open it, not only join one.
    const host = await makeHost({
      files: { "/w/f.json": report() },
      ghOverrides: {
        "api -X POST repos/acme/app/pulls/7/reviews": JSON.stringify({
          html_url: "https://github.com/acme/app/pull/7#pullrequestreview-1",
        }),
      },
    });
    const [finding] = await runReview(host);
    const posted = await host.call<{ finding: FindingDto }>("postFinding", {
      findingId: finding?.id,
      mode: "review",
    });
    expect(posted.finding.postedAs).toBe("pending-review");

    const create = host.calls.find((entry) =>
      entry.args.includes("repos/acme/app/pulls/7/reviews"),
    );
    expect(create?.args).toContain("--input");
    // No `event` field: that is what makes the review PENDING rather than
    // submitted the moment it is created.
    const payload = JSON.parse(create?.stdin ?? "{}") as {
      event?: string;
      comments: Array<{ path: string; line: number; start_line?: number }>;
    };
    expect(payload.event).toBeUndefined();
    expect(payload.comments[0]?.path).toBe("src/a.ts");
    expect(payload.comments[0]?.line).toBe(12);
    expect(payload.comments[0]?.start_line).toBe(10);
  });

  it("joins the existing review rather than starting a second one", async () => {
    const host = await makeHost({
      files: { "/w/f.json": report() },
      ghOverrides: { "api graphql -f query=query": "PRR_abc" },
    });
    const [finding] = await runReview(host);
    await host.call("postFinding", { findingId: finding?.id, mode: "review" });
    expect(
      host.calls.some((entry) => entry.args.includes("repos/acme/app/pulls/7/reviews")),
    ).toBe(false);
    expect(
      host.calls.some((entry) => entry.args.join(" ").includes("addPullRequestReviewThread")),
    ).toBe(true);
  });

  it("tells the panel when a review is already open", async () => {
    const host = await makeHost({
      ghOverrides: { "api graphql -f query=query": "PRR_abc" },
    });
    const detail = await host.call<{ hasPendingReview: boolean }>("getPullRequest", {
      repo: REPO,
      number: 7,
    });
    expect(detail.hasPendingReview).toBe(true);
  });

  it("does not re-ask GitHub for the pending review on every view", async () => {
    const host = await makeHost();
    const lookups = () =>
      host.calls.filter((entry) => entry.args.join(" ").includes("query=query")).length;
    await host.call("getPullRequest", { repo: REPO, number: 7 });
    const after = lookups();
    await host.call("getPullRequest", { repo: REPO, number: 7 });
    expect(lookups()).toBe(after);
  });

    it("explains a line GitHub will not place a thread on", async () => {
    // A null thread with no error means there is already a thread there.
    const host = await makeHost({
      files: { "/w/f.json": report() },
      ghOverrides: withPending({
        "api graphql -f query=mutation": JSON.stringify({
          data: { addPullRequestReviewThread: { thread: null } },
        }),
      }),
    });
    const [finding] = await runReview(host);
    await expect(
      host.call("postFinding", { findingId: finding?.id, mode: "inline" }),
    ).rejects.toThrow(/a comment thread already exists there/);
    // Nothing is marked posted on a failure.
    expect((await host.findings())[0]?.state).toBe("open");
  });

  it("still posts a general PR comment without consulting pending reviews", async () => {
    const host = await makeHost({
      files: { "/w/f.json": report() },
      ghOverrides: withPending(),
    });
    const [finding] = await runReview(host);
    const before = host.calls.length;
    await host.call("postFinding", { findingId: finding?.id, mode: "issue" });
    const graphqlCalls = host.calls
      .slice(before)
      .filter((entry) => entry.args.join(" ").includes("graphql"));
    expect(graphqlCalls).toEqual([]);
  });

  it("posts normally when the pending-review lookup fails", async () => {
    // The lookup is an optimisation; losing it must not block posting.
    const host = await makeHost({
      files: { "/w/f.json": report() },
      ghFailures: { "api graphql -f query=query": "500" },
    });
    const [finding] = await runReview(host);
    const posted = await host.call<{ finding: FindingDto }>("postFinding", {
      findingId: finding?.id,
      mode: "inline",
    });
    expect(posted.finding.postedAs).toBe("comment");
  });
});

describe("discussing a finding", () => {
  it("spawns one thread, seeds it with the finding, and reuses it", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    const first = await host.call<{ threadId: string }>("discussFinding", {
      findingId: finding?.id,
    });
    const second = await host.call<{ threadId: string }>("discussFinding", {
      findingId: finding?.id,
    });
    expect(second.threadId).toBe(first.threadId);
    // One review thread plus exactly one discussion thread.
    expect(host.spawned).toHaveLength(2);

    const prompt = host.spawned[1]?.prompt ?? "";
    expect(prompt).toContain("src/a.ts:10-12");
    expect(prompt).toContain(FINDING.problem);
    expect(prompt).toContain("Do not post anything to GitHub.");
    expect(host.spawned[1]?.parentThreadId).toBe("thr_1");
  });

  it("seeds the discussion with the user's edit when there is one", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    await host.call("setFindingComment", { findingId: finding?.id, comment: "My wording." });
    await host.call("discussFinding", { findingId: finding?.id });
    expect(host.spawned[1]?.prompt).toContain("My wording.");
  });
});

describe("review threads that end without reporting", () => {
  it("marks a running review failed when its thread goes idle", async () => {
    const host = await makeHost();
    const { review } = await host.call<{ review: ReviewDto }>("startReview", {
      repo: REPO,
      number: 7,
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: review.threadId as string }),
      lastAssistantText: "I gave up",
    });
    const after = await host.review();
    expect(after.status).toBe("failed");
    expect(after.error).toContain("without submitting findings");
  });

  it("leaves a review that already reported alone when its thread goes idle", async () => {
    // Ordering matters: the agent submits, then its turn ends. The idle event
    // must not overwrite a good result with a failure.
    const host = await makeHost({ files: { "/w/f.json": report() } });
    await runReview(host);
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_1" }),
      lastAssistantText: "done",
    });
    expect((await host.review()).status).toBe("reported");
  });

  it("ignores idle events for threads it does not own", async () => {
    const host = await makeHost();
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_unrelated" }),
      lastAssistantText: "done",
    });
    expect(host.harness.logEntries.some((entry) => entry.level === "error")).toBe(false);
  });
});

describe("the agent-facing CLI", () => {
  it("prints usage and the schema", async () => {
    const { harness } = await makeHost();
    expect((await harness.behavior.runCli([])).stdout).toContain("bb code-review submit");
    expect((await harness.behavior.runCli(["schema"])).stdout).toContain('"suggestedComment"');
  });

  it("tells the agent how to recover from a wrong review id", async () => {
    const { harness } = await makeHost({ files: { "/w/f.json": report() } });
    const result = await harness.behavior.runCli([
      "submit", "--review", "acme/app#404", "--file", "/w/f.json",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No review with id acme/app#404");
  });

  it("reports an unreadable file as an error, not a crash", async () => {
    const host = await makeHost();
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.submit("/w/missing.json");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Could not read");
  });

  it("accepts --flag=value as well as --flag value", async () => {
    const { harness } = await makeHost();
    const result = await harness.behavior.runCli(["submit", "--review=acme/app#7"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });

  it("prints a review's context for an agent that lost the prompt", async () => {
    const host = await makeHost();
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.harness.behavior.runCli([
      "context", "--review", REVIEW_ID, "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout ?? "").skills).toEqual(["code-review"]);
  });
});

describe("serving the PR to the review agent", () => {
  it("fetches the PR once, at review start, and serves it without gh", async () => {
    const host = await makeHost();
    await host.call("startReview", { repo: REPO, number: 7 });
    const ghCallsAfterStart = host.calls.length;

    const context = await host.harness.behavior.runCli(["context", "--review", REVIEW_ID]);
    const diff = await host.harness.behavior.runCli(["diff", "--review", REVIEW_ID]);
    const files = await host.harness.behavior.runCli(["files", "--review", REVIEW_ID]);

    expect(context.exitCode, context.stderr).toBe(0);
    expect(diff.exitCode).toBe(0);
    expect(files.exitCode).toBe(0);
    // The whole point: reading the PR costs the agent no GitHub access at all.
    expect(host.calls.length).toBe(ghCallsAfterStart);
  });

  it("gives the agent the description, discussion, and inline review comments", async () => {
    const host = await makeHost();
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.harness.behavior.runCli(["context", "--review", REVIEW_ID]);
    expect(result.stdout).toContain("Why this change exists.");
    expect(result.stdout).toContain("Looks good.");
    expect(result.stdout).toContain("sam on src/a.ts:11");
    expect(result.stdout).toContain("Head commit: sha7");
  });

  it("still starts the review when the repo refuses the review-comments endpoint", async () => {
    // That endpoint is optional; losing it must not cost the whole review.
    const host = await makeHost({ ghFailures: { "api --paginate repos": "403" } });
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.harness.behavior.runCli(["context", "--review", REVIEW_ID]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Existing review comments");
  });

  it("prints the whole diff when it fits", async () => {
    const host = await makeHost();
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.harness.behavior.runCli(["diff", "--review", REVIEW_ID]);
    expect(result.stdout).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(result.stdout).toContain("+b");
  });

  it("pages a diff too large to print, rather than being rejected for size", async () => {
    // The host rejects an over-budget CLI result atomically, so an unpaged
    // giant diff would tell the agent nothing at all.
    const huge = [
      `diff --git a/big.ts b/big.ts\n+${"x".repeat(900_000)}`,
      "diff --git a/small.ts b/small.ts\n+ok",
    ].join("\n");
    const host = await makeHost({ ghOverrides: { "pr diff": huge } });
    await host.call("startReview", { repo: REPO, number: 7 });

    const listed = await host.harness.behavior.runCli(["diff", "--review", REVIEW_ID]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("too large");
    expect(listed.stdout).toContain("--file big.ts");
    expect(listed.stdout).toContain("--file small.ts");

    const one = await host.harness.behavior.runCli([
      "diff", "--review", REVIEW_ID, "--file", "small.ts",
    ]);
    expect(one.stdout).toContain("+ok");
    expect(one.stdout).not.toContain("xxxx");
  });

  it("truncates a single oversized file instead of failing", async () => {
    const host = await makeHost({
      ghOverrides: { "pr diff": `diff --git a/big.ts b/big.ts\n+${"x".repeat(900_000)}` },
    });
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.harness.behavior.runCli([
      "diff", "--review", REVIEW_ID, "--file", "big.ts",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("[truncated");
    expect(Buffer.byteLength(result.stdout ?? "", "utf8")).toBeLessThan(1_048_576);
  });

  it("names the real files when asked for one that is not in the diff", async () => {
    const host = await makeHost();
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.harness.behavior.runCli([
      "diff", "--review", REVIEW_ID, "--file", "nope.ts",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not in this pull request's diff");
    expect(result.stderr).toContain("src/a.ts");
  });

  it("lists the changed files with their line counts", async () => {
    const host = await makeHost();
    await host.call("startReview", { repo: REPO, number: 7 });
    const result = await host.harness.behavior.runCli(["files", "--review", REVIEW_ID]);
    expect(result.stdout).toContain("src/a.ts  +3 -1");
  });

  it("tells the agent to re-run the review when there is no snapshot", async () => {
    const host = await makeHost();
    const result = await host.harness.behavior.runCli(["diff", "--review", REVIEW_ID]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Re-run the review");
  });

  it("refuses to start a review it cannot fetch, instead of spawning a blind agent", async () => {
    const host = await makeHost({ ghFailures: { "pr diff": "network down" } });
    await expect(host.call("startReview", { repo: REPO, number: 7 })).rejects.toThrow(
      /network down/,
    );
    expect(host.spawned).toHaveLength(0);
  });
});

describe("the code an issue points at", () => {
  it("returns the finding's own site with real file line numbers", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    const code = await host.call<{
      prUrl: string;
      locations: Array<{
        file: string;
        firstLine: number;
        lines: string[];
        isPrimary: boolean;
        diffUrl: string;
        error: string | null;
      }>;
    }>("getFindingCode", { findingId: finding?.id, context: 2 });

    expect(code.prUrl).toBe("https://github.com/acme/app/pull/7");
    const primary = code.locations.find((location) => location.isPrimary);
    expect(primary?.file).toBe("src/a.ts");
    // Cited lines are 10-12, context 2, so the window starts at line 8.
    expect(primary?.firstLine).toBe(8);
    expect(primary?.lines[0]).toBe("line 8");
    expect(primary?.lines.at(-1)).toBe("line 14");
    expect(primary?.error).toBeNull();
  });

  it("anchors the GitHub link at the file and line, the way GitHub does", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    const code = await host.call<{ locations: Array<{ diffUrl: string }> }>("getFindingCode", {
      findingId: finding?.id,
    });
    // GitHub anchors a PR file by sha256 of its repo-relative path.
    const digest = createHash("sha256").update("src/a.ts").digest("hex");
    expect(code.locations[0]?.diffUrl).toBe(
      `https://github.com/acme/app/pull/7/files#diff-${digest}R10`,
    );
  });

  it("clamps the window to the start of the file", async () => {
    const host = await makeHost({
      files: { "/w/f.json": report([{ ...FINDING, startLine: 1, endLine: 1 }]) },
    });
    const [finding] = await runReview(host);
    const code = await host.call<{
      locations: Array<{ firstLine: number; hasMoreAbove: boolean; hasMoreBelow: boolean }>;
    }>("getFindingCode", { findingId: finding?.id, context: 5 });
    expect(code.locations[0]?.firstLine).toBe(1);
    expect(code.locations[0]?.hasMoreAbove).toBe(false);
    expect(code.locations[0]?.hasMoreBelow).toBe(true);
  });

  it("also shows files the finding cited in prose", async () => {
    // Agents cite supporting code inline far more often than they fill in a
    // structured field, and that code is worth showing.
    const host = await makeHost({
      files: {
        "/w/f.json": report([
          { ...FINDING, problem: "This contradicts src/other.ts:20-22, which retries." },
        ]),
      },
    });
    const [finding] = await runReview(host);
    const code = await host.call<{ locations: Array<{ file: string; isPrimary: boolean }> }>(
      "getFindingCode",
      { findingId: finding?.id },
    );
    expect(code.locations.map((location) => location.file)).toEqual([
      "src/a.ts",
      "src/other.ts",
    ]);
    expect(code.locations[1]?.isPrimary).toBe(false);
  });

it("expands a bare filename the agent cited into the PR's real path", async () => {
    const host = await makeHost({
      files: {
        "/w/f.json": report([
          { ...FINDING, problem: "Unlike a.ts:4, which retries." },
        ]),
      },
    });
    const [finding] = await runReview(host);
    const code = await host.call<{
      locations: Array<{ file: string; startLine: number | null }>;
    }>("getFindingCode", { findingId: finding?.id });
    // "a.ts:4" resolves against the PR's own file list to src/a.ts, and stays
    // a separate location because it points at a different line.
    expect(code.locations.map((location) => location.file)).toEqual(["src/a.ts", "src/a.ts"]);
    expect(code.locations.map((location) => location.startLine)).toEqual([10, 4]);
  });

  it("explains a cited file that is not in the repo, without the raw gh error", async () => {
    const host = await makeHost({
      files: {
        "/w/f.json": report([{ ...FINDING, problem: "See made/up/thing.ts:9 for the pattern." }]),
      },
      ghFailures: { "api repos/acme/app/contents/made/up/thing.ts": "gh: Not Found (HTTP 404)" },
    });
    const [finding] = await runReview(host);
    const code = await host.call<{ locations: Array<{ file: string; error: string | null }> }>(
      "getFindingCode",
      { findingId: finding?.id },
    );
    const missing = code.locations.find((location) => location.file === "made/up/thing.ts");
    expect(missing?.error).toContain("is not in the repository at");
    expect(missing?.error).not.toContain("gh:");
  });

  it("does not show one line twice when the finding cites it two ways", async () => {
    const host = await makeHost({
      files: {
        "/w/f.json": report([
          { ...FINDING, problem: "Also written as a.ts:10 elsewhere in this text." },
        ]),
      },
    });
    const [finding] = await runReview(host);
    const code = await host.call<{ locations: Array<{ file: string; startLine: number }> }>(
      "getFindingCode",
      { findingId: finding?.id },
    );
    expect(code.locations).toHaveLength(1);
    expect(code.locations[0]?.file).toBe("src/a.ts");
  });

  it("resolves a citation to code outside the PR using the repo tree", async () => {
    const host = await makeHost({
      files: {
        "/w/f.json": report([{ ...FINDING, problem: "Unlike outside.ts:3, which retries." }]),
      },
    });
    const [finding] = await runReview(host);
    const code = await host.call<{ locations: Array<{ file: string }> }>("getFindingCode", {
      findingId: finding?.id,
    });
    expect(code.locations.map((location) => location.file)).toContain("vendor/outside.ts");
  });

  it("does not read the repo tree when every citation is a PR file", async () => {
    // The tree is a whole extra API call; showing code is only worth it on a
    // miss. (Submit reads it once to validate paths, hence the baseline.)
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    const treeCalls = () =>
      host.calls.filter((entry) => entry.args.join(" ").includes("/git/trees/")).length;
    const before = treeCalls();
    await host.call("getFindingCode", { findingId: finding?.id });
    expect(treeCalls()).toBe(before);
  });

    it("shows an explicit reference with the note that explains it", async () => {
    const host = await makeHost({
      files: {
        "/w/f.json": report([
          {
            ...FINDING,
            references: [
              { file: "src/ref.ts", startLine: 5, endLine: 6, note: "the pattern to match" },
            ],
          },
        ]),
      },
    });
    const [finding] = await runReview(host);
    const code = await host.call<{ locations: Array<{ file: string; note: string }> }>(
      "getFindingCode",
      { findingId: finding?.id },
    );
    expect(code.locations[1]?.file).toBe("src/ref.ts");
    expect(code.locations[1]?.note).toBe("the pattern to match");
  });

  it("reports a file it cannot read as a note, not a failed request", async () => {
    const host = await makeHost({
      files: { "/w/f.json": report() },
      ghFailures: { "api repos/acme/app/contents": "404 Not Found" },
    });
    const [finding] = await runReview(host);
    const code = await host.call<{ locations: Array<{ error: string | null; lines: string[] }> }>(
      "getFindingCode",
      { findingId: finding?.id },
    );
    expect(code.locations[0]?.error).toContain("is not in the repository at");
    expect(code.locations[0]?.lines).toEqual([]);
  });

  it("fetches each file once and serves the rest from cache", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    const contentCalls = () =>
      host.calls.filter((entry) => entry.args.join(" ").includes("/contents/")).length;
    await host.call("getFindingCode", { findingId: finding?.id });
    const afterFirst = contentCalls();
    expect(afterFirst).toBeGreaterThan(0);
    await host.call("getFindingCode", { findingId: finding?.id, context: 25 });
    expect(contentCalls()).toBe(afterFirst);
  });

  it("drops cached file bodies when the review is re-run", async () => {
    // A re-run may sit on a newer commit, where the same path has other lines.
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    await host.call("getFindingCode", { findingId: finding?.id });
    const before = host.calls.filter((entry) => entry.args.join(" ").includes("/contents/")).length;
    await runReview(host);
    const [refreshed] = await host.findings();
    await host.call("getFindingCode", { findingId: refreshed?.id });
    expect(
      host.calls.filter((entry) => entry.args.join(" ").includes("/contents/")).length,
    ).toBeGreaterThan(before);
  });
});

describe("a review with no stored commit", () => {
  /** Drop the snapshot, the way a review from before snapshots existed has none. */
  function forgetSnapshot(host: Host) {
    host.bb.storage.database().prepare(`DELETE FROM review_context`).run();
  }

  it("fetches the code rather than making the user re-run the review", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    forgetSnapshot(host);

    const code = await host.call<{
      isReviewedCommit: boolean;
      headSha: string;
      locations: Array<{ lines: string[]; error: string | null }>;
    }>("getFindingCode", { findingId: finding?.id, context: 2 });

    expect(code.locations[0]?.error).toBeNull();
    expect(code.locations[0]?.lines.length).toBeGreaterThan(0);
    expect(code.headSha).toBe("sha7");
  });

  it("says the code is not the commit that was reviewed", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    forgetSnapshot(host);
    const code = await host.call<{ isReviewedCommit: boolean }>("getFindingCode", {
      findingId: finding?.id,
    });
    expect(code.isReviewedCommit).toBe(false);
  });

  it("reports the reviewed commit as such when it was recorded", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    const code = await host.call<{ isReviewedCommit: boolean }>("getFindingCode", {
      findingId: finding?.id,
    });
    expect(code.isReviewedCommit).toBe(true);
  });

  it("re-fetches only once, then serves the recovered snapshot", async () => {
    const host = await makeHost({ files: { "/w/f.json": report() } });
    const [finding] = await runReview(host);
    forgetSnapshot(host);
    await host.call("getFindingCode", { findingId: finding?.id });
    const after = host.calls.filter((entry) => entry.args.join(" ").startsWith("pr diff")).length;
    await host.call("getFindingCode", { findingId: finding?.id, context: 25 });
    expect(host.calls.filter((entry) => entry.args.join(" ").startsWith("pr diff")).length).toBe(
      after,
    );
  });
});

describe("the panel's remembered state", () => {
  it("starts empty and round-trips what the panel saves", async () => {
    const host = await makeHost();
    expect(await host.call("getPanelState", null)).toEqual({ repo: null, filter: null });

    await host.call("setPanelState", { repo: REPO, filter: { kind: "team", teamSlug: "acme/core" } });
    expect(await host.call("getPanelState", null)).toEqual({
      repo: REPO,
      filter: { kind: "team", teamSlug: "acme/core" },
    });
  });

  it("overwrites rather than accumulating", async () => {
    const host = await makeHost();
    await host.call("setPanelState", { repo: REPO, filter: { kind: "mine" } });
    await host.call("setPanelState", { repo: "acme/other", filter: { kind: "all" } });
    expect(await host.call("getPanelState", null)).toEqual({
      repo: "acme/other",
      filter: { kind: "all" },
    });
  });

  it("ignores a stored filter a newer build no longer understands", async () => {
    const host = await makeHost();
    await host.call("setPanelState", { repo: REPO, filter: { kind: "mine" } });
    host.bb.storage.database().prepare(`UPDATE panel_state SET filter = ?`).run('{"kind":"gone"}');
    expect(await host.call("getPanelState", null)).toEqual({ repo: REPO, filter: null });
  });
});

describe("registrations", () => {
  it("registers the panel's data plane, the CLI, and the idle handler", async () => {
    const { harness } = await makeHost();
    for (const method of [
      "status",
      "listPullRequests",
      "getPullRequest",
      "startReview",
      "setFindingComment",
      "setFindingState",
      "postFinding",
      "discussFinding",
    ]) {
      expect(harness.registrations.rpcMethods).toContain(method);
    }
    expect(harness.registrations.cli?.name).toBe("code-review");
    expect(harness.registrations.cli?.commands?.map((entry) => entry.name)).toEqual([
      "context",
      "diff",
      "files",
      "schema",
      "submit",
    ]);
    for (const method of ["getFindingCode", "getPanelState", "setPanelState"]) {
      expect(harness.registrations.rpcMethods).toContain(method);
    }
    expect(harness.registrations.threadEventHandlers["thread.idle"]).toBe(1);
  });
});
