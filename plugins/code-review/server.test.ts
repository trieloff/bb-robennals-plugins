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
    "pr diff":
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b",
    "api -X": JSON.stringify({ html_url: "https://github.com/acme/app/pull/7#c1" }),
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
    async runCommand(file, args) {
      calls.push({ file, args });
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

  it("serves repeat calls from cache and refetches only on refresh", async () => {
    const { call, calls } = await makeHost();
    const listCalls = () =>
      calls.filter((entry) => entry.args[0] === "pr" && entry.args[1] === "list").length;
    await call("listPullRequests", { repo: REPO, filter: { kind: "all" } });
    const afterFirst = listCalls();
    await call("listPullRequests", { repo: REPO, filter: { kind: "all" } });
    expect(listCalls()).toBe(afterFirst);
    await call("listPullRequests", { repo: REPO, filter: { kind: "all" }, refresh: true });
    expect(listCalls()).toBe(afterFirst + 1);
  });
});

describe("getPullRequest", () => {
  it("splits the diff into one patch per file", async () => {
    const { call } = await makeHost();
    const detail = await call<{
      files: Array<{ path: string; patch: string }>;
      review: ReviewDto | null;
      diffError: string | null;
    }>("getPullRequest", { repo: REPO, number: 7 });
    expect(detail.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(detail.diffError).toBeNull();
    expect(detail.review).toBeNull();
  });

  it("still returns the PR and its findings when the diff cannot be fetched", async () => {
    // An unfetchable diff must not take the findings down with it — the diff
    // is the least important thing on the page.
    const host = await makeHost({ files: { "/w/f.json": report() } });
    await runReview(host);
    // The review already has its own fetched snapshot; only browsing the live
    // diff should be affected.
    host.failures["pr diff"] = "boom";
    const detail = await host.call<{
      files: unknown[];
      diffError: string | null;
      findings: FindingDto[];
      pullRequest: { title: string } | null;
    }>("getPullRequest", { repo: REPO, number: 7 });
    expect(detail.files).toEqual([]);
    expect(detail.diffError).toContain("boom");
    expect(detail.findings).toHaveLength(1);
    expect(detail.pullRequest?.title).toBe("Add a thing");
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
    expect(harness.registrations.threadEventHandlers["thread.idle"]).toBe(1);
  });
});
