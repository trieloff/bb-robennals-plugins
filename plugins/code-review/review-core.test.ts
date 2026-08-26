import { describe, expect, it } from "vitest";
import {
  buildPostCommentArgs,
  formatContext,
  formatFileList,
  parsePrSnapshot,
  parseReviewComments,
  buildReviewPrompt,
  filterPullRequests,
  parsePullRequests,
  parseReport,
  parseRepoList,
  parseSkillList,
  splitUnifiedDiff,
  type PullRequest,
} from "./review-core";

function pr(overrides: Partial<PullRequest>): PullRequest {
  return {
    repo: "acme/app",
    number: 1,
    title: "t",
    author: "a",
    url: "",
    updatedAt: "",
    isDraft: false,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    headRefOid: "",
    baseRefName: "main",
    headRefName: "feature",
    labels: [],
    reviewRequests: [],
    ...overrides,
  };
}

describe("parseReport", () => {
  const complete = {
    file: "src/a.ts",
    startLine: 4,
    endLine: 6,
    side: "RIGHT",
    severity: "high",
    category: "correctness",
    title: "Off by one",
    background: "b",
    problem: "p",
    suggestedFix: "f",
    suggestedComment: "c",
  };

  it("accepts the documented envelope", () => {
    const { report, errors } = parseReport(
      JSON.stringify({ summary: "looks ok", findings: [complete] }),
    );
    expect(errors).toEqual([]);
    expect(report?.summary).toBe("looks ok");
    expect(report?.findings).toHaveLength(1);
    expect(report?.findings[0]?.startLine).toBe(4);
  });

  it("accepts a bare array of findings", () => {
    const { report } = parseReport(JSON.stringify([complete]));
    expect(report?.findings).toHaveLength(1);
  });

  it("accepts snake_case and `line` aliases", () => {
    const { report, errors } = parseReport(
      JSON.stringify({
        findings: [
          {
            path: "src/b.ts",
            line: 12,
            severity: "NIT",
            title: "x",
            problem: "p",
            suggested_comment: "c",
            suggested_fix: "f",
          },
        ],
      }),
    );
    expect(errors).toEqual([]);
    const finding = report?.findings[0];
    expect(finding?.file).toBe("src/b.ts");
    expect(finding?.startLine).toBe(12);
    expect(finding?.endLine).toBe(12);
    expect(finding?.severity).toBe("nit");
    expect(finding?.side).toBe("RIGHT");
  });

  it("straightens a backwards range instead of dropping the finding", () => {
    const { report } = parseReport(
      JSON.stringify({ findings: [{ ...complete, startLine: 9, endLine: 3 }] }),
    );
    expect(report?.findings[0]?.endLine).toBe(9);
  });

  it("keeps the good findings and reports the bad one", () => {
    const { report, errors } = parseReport(
      JSON.stringify({ findings: [complete, { file: "src/c.ts" }, complete] }),
    );
    expect(report?.findings).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("finding 2 dropped");
  });

  it("reports malformed JSON and an unusable shape without throwing", () => {
    expect(parseReport("{ not json").report).toBeNull();
    expect(parseReport('{"summary":"x"}').report).toBeNull();
  });

  it("treats an empty findings array as a valid result", () => {
    const { report, errors } = parseReport(JSON.stringify({ summary: "clean", findings: [] }));
    expect(errors).toEqual([]);
    expect(report?.findings).toEqual([]);
  });
});

describe("buildReviewPrompt", () => {
  const base = {
    repo: "acme/app",
    number: 7,
    title: "Add a thing",
    reviewId: "acme/app#7",
    findingsPath: ".bb/code-review/acme-app-7.json",
    skills: ["rob-review"],
    extraInstructions: "",
    headSha: "a804d164384ae76abbb816992b22b0fb4d7cd351",
  };

  it("names the review id, path, and every skill", () => {
    const prompt = buildReviewPrompt(base);
    expect(prompt).toContain("acme/app#7");
    expect(prompt).toContain(".bb/code-review/acme-app-7.json");
    expect(prompt).toContain("`rob-review` skill");
    expect(prompt).toContain(
      "bb code-review submit --review acme/app#7 --file .bb/code-review/acme-app-7.json",
    );
  });

  it("sends the agent to the plugin, never to gh", () => {
    // The agent sandbox cannot reach gh, and the plugin has already fetched
    // everything — so the prompt must not ask for a network round trip.
    const prompt = buildReviewPrompt(base);
    expect(prompt).toContain("bb code-review context --review acme/app#7");
    expect(prompt).toContain("bb code-review diff --review acme/app#7");
    expect(prompt).not.toContain("gh pr ");
    expect(prompt).toContain("you do NOT need `gh`");
  });

  it("pins the agent to the head commit the diff was fetched at", () => {
    expect(buildReviewPrompt(base)).toContain("a804d164384a");
  });

  it("keeps the blank lines that make it render as Markdown", () => {
    // Regression: a filter meant to drop conditional lines dropped every
    // paragraph break, collapsing the prompt into a wall of text.
    const prompt = buildReviewPrompt(base);
    expect(prompt).toContain("\n\n## 1. Read the change\n\n");
    expect(prompt).toContain("\n\n```json\n");
  });

  it("omits the extra-instructions block when it is empty", () => {
    expect(buildReviewPrompt(base)).not.toContain("\n\n\n");
    expect(buildReviewPrompt({ ...base, extraInstructions: "Never nit imports." })).toContain(
      "Never nit imports.",
    );
  });

  it("falls back to a generic review when no skills are configured", () => {
    const prompt = buildReviewPrompt({ ...base, skills: [] });
    expect(prompt).toContain("correctness bugs");
    expect(prompt).not.toContain("skill`");
  });
});

describe("filterPullRequests", () => {
  const context = { viewer: "robennals", myTeams: ["acme/core", "acme/infra"] };
  const direct = pr({ number: 1, reviewRequests: [{ login: "robennals", teamSlug: null }] });
  const viaTeam = pr({ number: 2, reviewRequests: [{ login: null, teamSlug: "acme/core" }] });
  const otherTeam = pr({ number: 3, reviewRequests: [{ login: null, teamSlug: "acme/design" }] });
  const nobody = pr({ number: 4 });
  const all = [direct, viaTeam, otherTeam, nobody];

  it("separates a direct request from a team request", () => {
    // This is the distinction GitHub's own `review-requested:@me` collapses.
    expect(filterPullRequests(all, { kind: "mine" }, context).map((p) => p.number)).toEqual([1]);
    expect(filterPullRequests(all, { kind: "my-teams" }, context).map((p) => p.number)).toEqual([2]);
  });

  it("filters to one chosen team", () => {
    expect(
      filterPullRequests(all, { kind: "team", teamSlug: "acme/design" }, context).map((p) => p.number),
    ).toEqual([3]);
  });

  it("matches logins and team slugs case-insensitively", () => {
    const shouty = pr({ number: 5, reviewRequests: [{ login: "RobEnnals", teamSlug: null }] });
    expect(filterPullRequests([shouty], { kind: "mine" }, context)).toHaveLength(1);
  });

  it("passes everything through for `all`", () => {
    expect(filterPullRequests(all, { kind: "all" }, context)).toHaveLength(4);
  });
});

describe("parsePullRequests", () => {
  it("reads gh's User and Team review-request shapes", () => {
    const [parsed] = parsePullRequests(
      JSON.stringify([
        {
          number: 5801,
          title: "fix",
          author: { login: "dan" },
          additions: 3,
          reviewRequests: [
            { __typename: "Team", name: "psi-committers", slug: "acme/psi-committers" },
            { __typename: "User", login: "robennals" },
          ],
          labels: [{ name: "bug" }],
        },
      ]),
      "acme/app",
    );
    expect(parsed?.repo).toBe("acme/app");
    expect(parsed?.additions).toBe(3);
    expect(parsed?.labels).toEqual(["bug"]);
    expect(parsed?.reviewRequests).toEqual([
      { login: null, teamSlug: "acme/psi-committers" },
      { login: "robennals", teamSlug: null },
    ]);
  });

  it("skips entries with no number rather than throwing", () => {
    expect(parsePullRequests(JSON.stringify([{ title: "junk" }]), "acme/app")).toEqual([]);
  });
});

describe("splitUnifiedDiff", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");

  it("returns one self-contained patch per file", () => {
    const files = splitUnifiedDiff(diff);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0]?.patch).toContain("+new");
    expect(files[0]?.patch).not.toContain("+y");
    expect(files[1]?.patch.startsWith("diff --git")).toBe(true);
  });

  it("uses the b-side path so a rename reads as its new name", () => {
    const renamed = "diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n";
    expect(splitUnifiedDiff(renamed)[0]?.path).toBe("new.ts");
  });

  it("returns nothing for an empty diff", () => {
    expect(splitUnifiedDiff("")).toEqual([]);
  });
});

describe("settings parsing", () => {
  it("takes repos one per line, comma separated, or as URLs", () => {
    expect(parseRepoList("acme/app\nhttps://github.com/acme/lib.git, acme/app")).toEqual([
      "acme/app",
      "acme/lib",
    ]);
  });

  it("drops entries that are not owner/repo", () => {
    expect(parseRepoList("acme/app\nnot-a-repo\n")).toEqual(["acme/app"]);
  });

  it("takes skills one per line and tolerates a leading slash", () => {
    expect(parseSkillList("/code-review\nrob-review\ncode-review")).toEqual([
      "code-review",
      "rob-review",
    ]);
  });
});

describe("buildPostCommentArgs", () => {
  const base = {
    repo: "acme/app",
    number: 7,
    body: "Please fix this.",
    headSha: "abc123",
    file: "src/a.ts",
    side: "RIGHT" as const,
  };

  it("anchors a multi-line finding with start_line before line", () => {
    const argv = buildPostCommentArgs({
      ...base, startLine: 10, endLine: 12, mode: "inline",
    });
    expect(argv).toContain("repos/acme/app/pulls/7/comments");
    // `line` is the LAST line of the range; `start_line` the first.
    expect(argv).toContain("line=12");
    expect(argv).toContain("start_line=10");
    expect(argv).toContain("start_side=RIGHT");
    expect(argv).toContain("commit_id=abc123");
  });

  it("omits start_line for a single line, which GitHub rejects otherwise", () => {
    const argv = buildPostCommentArgs({
      ...base, startLine: 10, endLine: 10, mode: "inline",
    });
    expect(argv).toContain("line=10");
    expect(argv.some((arg) => arg.startsWith("start_line="))).toBe(false);
  });

  it("treats a null endLine as a single line", () => {
    const argv = buildPostCommentArgs({ ...base, startLine: 4, endLine: null, mode: "inline" });
    expect(argv).toContain("line=4");
    expect(argv.some((arg) => arg.startsWith("start_line="))).toBe(false);
  });

  it("falls back to an issue comment when there is no line anchor", () => {
    const argv = buildPostCommentArgs({
      ...base, startLine: null, endLine: null, mode: "inline",
    });
    expect(argv).toContain("repos/acme/app/issues/7/comments");
    expect(argv.some((arg) => arg.startsWith("path="))).toBe(false);
  });

  it("honours an explicit issue-comment request even with line anchors", () => {
    const argv = buildPostCommentArgs({ ...base, startLine: 10, endLine: 12, mode: "issue" });
    expect(argv).toContain("repos/acme/app/issues/7/comments");
    expect(argv).toContain("body=Please fix this.");
  });

  it("passes the body as a single -f argument so newlines survive", () => {
    const argv = buildPostCommentArgs({
      ...base, body: "line one\nline two", startLine: null, endLine: null, mode: "issue",
    });
    expect(argv).toContain("body=line one\nline two");
  });
});

describe("formatContext", () => {
  const snapshot = {
    title: "Add a thing",
    body: "Why this change exists.",
    author: "dan",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feature",
    headSha: "sha7",
    comments: [
      { author: "kim", body: "Looks good to me.", createdAt: "", file: null, line: null },
    ],
    reviewComments: [
      { author: "sam", body: "This bound is off.", createdAt: "", file: "src/a.ts", line: 11 },
    ],
    files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
  };

  it("gives the agent the description, both kinds of comment, and the file list", () => {
    const text = formatContext("acme/app#7", snapshot);
    expect(text).toContain("# acme/app#7 — Add a thing");
    expect(text).toContain("Why this change exists.");
    expect(text).toContain("Looks good to me.");
    // An inline review comment must say where it was left, or it is unusable.
    expect(text).toContain("sam on src/a.ts:11");
    expect(text).toContain("This bound is off.");
    expect(text).toContain("- src/a.ts (+3 −1)");
    expect(text).toContain("Head commit: sha7");
  });

  it("says so rather than printing an empty section for a bare PR", () => {
    const text = formatContext("acme/app#7", {
      ...snapshot,
      body: "",
      comments: [],
      reviewComments: [],
      files: [],
    });
    expect(text).toContain("(no description)");
    expect(text).not.toContain("## Discussion");
    expect(text).not.toContain("## Existing review comments");
  });
});

describe("parsePrSnapshot", () => {
  it("reads gh pr view's shape", () => {
    const snapshot = parsePrSnapshot(
      JSON.stringify({
        title: "Add a thing",
        body: "b",
        author: { login: "dan" },
        state: "OPEN",
        isDraft: true,
        baseRefName: "main",
        headRefName: "feature",
        headRefOid: "sha7",
        comments: [{ author: { login: "kim" }, body: "hi", createdAt: "2026-01-01" }],
        files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
      }),
    );
    expect(snapshot.author).toBe("dan");
    expect(snapshot.headSha).toBe("sha7");
    expect(snapshot.isDraft).toBe(true);
    expect(snapshot.comments[0]).toEqual({
      author: "kim",
      body: "hi",
      createdAt: "2026-01-01",
      file: null,
      line: null,
    });
    expect(snapshot.files).toEqual([{ path: "src/a.ts", additions: 3, deletions: 1 }]);
  });

  it("survives a PR with no body, comments, or files", () => {
    const snapshot = parsePrSnapshot(JSON.stringify({ title: "t" }));
    expect(snapshot.body).toBe("");
    expect(snapshot.comments).toEqual([]);
    expect(snapshot.files).toEqual([]);
  });
});

describe("parseReviewComments", () => {
  it("reads the REST shape, including the user/login nesting", () => {
    const comments = parseReviewComments(
      JSON.stringify([
        { path: "src/a.ts", line: 11, user: { login: "sam" }, body: "off by one", created_at: "x" },
      ]),
    );
    expect(comments).toEqual([
      { author: "sam", body: "off by one", createdAt: "x", file: "src/a.ts", line: 11 },
    ]);
  });

  it("falls back to original_line for a comment on an outdated diff", () => {
    const [comment] = parseReviewComments(
      JSON.stringify([{ path: "src/a.ts", original_line: 4, user: { login: "sam" }, body: "b" }]),
    );
    expect(comment?.line).toBe(4);
  });

  it("returns nothing for a repo that answers with an object", () => {
    expect(parseReviewComments(JSON.stringify({ message: "Not Found" }))).toEqual([]);
  });
});

describe("formatFileList", () => {
  it("gives one runnable command per file", () => {
    const text = formatFileList("acme/app#7", [
      { path: "src/a.ts", patch: "" },
      { path: "src/b.ts", patch: "" },
    ]);
    expect(text).toContain("too large");
    expect(text).toContain("bb code-review diff --review acme/app#7 --file src/a.ts");
    expect(text).toContain("bb code-review diff --review acme/app#7 --file src/b.ts");
  });
});
