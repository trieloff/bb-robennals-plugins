// @vitest-environment jsdom
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { describe, expect, it } from "vitest";
import type { FindingDto, PullRequestDto, ReviewDto } from "./server";

/**
 * The thunk matters: app.tsx binds the plugin runtime at module load, so
 * loadPluginApp must install the test runtime before importing it.
 */
const load = () => loadPluginApp(() => import("./app"));

const READY = {
  state: "ready" as const,
  detail: null,
  viewer: "robennals",
  repos: ["acme/app"],
  myTeams: ["acme/core"],
  skills: ["code-review"],
};

const PR: PullRequestDto = {
  repo: "acme/app",
  number: 7,
  title: "Add a thing",
  author: "dan",
  url: "https://github.com/acme/app/pull/7",
  updatedAt: "2026-01-02T00:00:00Z",
  isDraft: false,
  additions: 3,
  deletions: 1,
  changedFiles: 2,
  headRefOid: "sha7",
  baseRefName: "main",
  headRefName: "feature",
  labels: [],
  reviewRequests: [{ login: "robennals", teamSlug: null }],
  reviewStatus: "reported",
  openFindings: 1,
  postedFindings: 0,
};

const REVIEW: ReviewDto = {
  id: "acme/app#7",
  repo: "acme/app",
  number: 7,
  title: "Add a thing",
  status: "reported",
  summary: "",
  error: null,
  threadId: "thr_1",
  findingsPath: "/w/f.json",
  skills: ["code-review"],
  createdAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

const FINDING: FindingDto = {
  id: "f1",
  reviewId: "acme/app#7",
  file: "src/a.ts",
  startLine: 10,
  endLine: 12,
  side: "RIGHT",
  severity: "high",
  category: "correctness",
  title: "Off by one",
  gist: "The loop runs one past the end of the buffer.",
  summary: "The loop runs one past the end of the buffer.",
  background: "The loop walks the buffer.",
  problem: "It runs one past the end.",
  suggestedFix: "Use < instead of <=.",
  suggestedComment: "Please fix the bound here.",
  draftComment: null,
  state: "open",
  commentUrl: null,
  postedAt: null,
  discussionThreadId: null,
  references: [],
};

const CODE = {
  prUrl: "https://github.com/acme/app/pull/7",
  locations: [
    {
      file: "src/a.ts",
      startLine: 10,
      endLine: 12,
      note: "",
      isPrimary: true,
      diffUrl: "https://github.com/acme/app/pull/7/files#diff-abc123R10",
      firstLine: 9,
      lines: ["line nine", "const x = 1;", "const y = 2;", "const z = 3;", "line thirteen"],
      hasMoreAbove: true,
      hasMoreBelow: true,
      error: null,
    },
    {
      file: "src/other.ts",
      startLine: 20,
      endLine: 20,
      note: "the pattern this should match",
      isPrimary: false,
      diffUrl: "https://github.com/acme/app/pull/7/files#diff-def456R20",
      firstLine: 20,
      lines: ["retry(() => run());"],
      hasMoreAbove: true,
      hasMoreBelow: true,
      error: null,
    },
  ],
};

/** The panel's RPC surface, with per-test overrides. */
function rpc(overrides: Record<string, unknown> = {}) {
  return {
    status: () => READY,
    listPullRequests: () => ({ pullRequests: [PR] }),
    getPullRequest: () => ({ pullRequest: PR, review: REVIEW, findings: [FINDING] }),
    getFindingCode: () => CODE,
    getPanelState: () => ({ repo: null, filter: null }),
    setPanelState: () => ({ repo: null, filter: null }),
    ...overrides,
  };
}

describe("registrations", () => {
  it("registers one nav panel with a discussion fixed tab that names it", async () => {
    // loadPluginApp applies the host's own validation, so this catches slot-id,
    // path, and fixed-tab/panel mismatches that would break the real panel.
    const app = await load();
    expect(app.navPanels).toHaveLength(1);
    const panel = app.navPanels[0];
    expect(panel?.id).toBe("code-review");
    expect(panel?.path).toBe("code-review");
    expect(panel?.fixedTabs).toHaveLength(1);
    // A fixed tab whose panelId does not match its panel is rejected by BB.
    expect(panel?.fixedTabs?.[0]?.panelId).toBe(panel?.id);
    expect(panel?.fixedTabs?.[0]?.id).toBe("discussion");
  });
});

describe("the pull request list", () => {
  it("lists the PRs the filter returned", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    await slot.findByText("dan");
    slot.lifecycle.unmount();
  });

  it("asks for the direct-request filter first", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    const listCall = slot.inspection.rpcCalls.find((entry) => entry.method === "listPullRequests");
    expect((listCall?.input as { filter: { kind: string } }).filter.kind).toBe("mine");
    slot.lifecycle.unmount();
  });

  it("explains an empty list instead of showing a blank page", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: rpc({ listPullRequests: () => ({ pullRequests: [] }) }) },
    );
    await slot.findByText("Nothing to review");
    slot.lifecycle.unmount();
  });

  it("tells the user how to fix an unconfigured gh instead of failing silently", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: rpc({
          status: () => ({ ...READY, state: "needs_configuration", detail: "gh not found" }),
        }),
      },
    );
    await slot.findByText("The GitHub CLI needs setting up");
    await slot.findByText("gh not found");
    slot.lifecycle.unmount();
  });
});

describe("a PR's issue list", () => {
  it("deep-links to a PR through the panel's subPath", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getPullRequest");
    expect(call?.input).toEqual({ repo: "acme/app", number: 7 });
    slot.lifecycle.unmount();
  });

  it("shows each issue as a title, a gist, and a location — not the full detail", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await slot.findByText("Off by one");
    await slot.findByText("The loop runs one past the end of the buffer.");
    await slot.findByText("src/a.ts:10-12");
    // The list is a summary: the long-form fields belong to the detail view.
    expect(slot.queryByText("The loop walks the buffer.")).toBeNull();
    expect(slot.queryByLabelText("Comment for Off by one")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("offers a way into the PR on GitHub", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    const link = await slot.findByText("Open on GitHub");
    expect(link.closest("a")?.getAttribute("href")).toBe("https://github.com/acme/app/pull/7");
    slot.lifecycle.unmount();
  });

  it("falls back to the problem when the agent wrote no summary", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [{ ...FINDING, summary: "", gist: "It runs one past the end." }],
          }),
        }),
      },
    );
    await slot.findByText("It runs one past the end.");
    slot.lifecycle.unmount();
  });

  it("explains a review that has not run yet", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: { ...PR, reviewStatus: "none", openFindings: 0 },
            review: null,
            findings: [],
          }),
        }),
      },
    );
    await slot.findByText("No review yet");
    await slot.findByText("Review this PR");
    slot.lifecycle.unmount();
  });

  it("surfaces a failed review's error", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: { ...REVIEW, status: "failed", error: "the thread gave up" },
            findings: [],
          }),
        }),
      },
    );
    await slot.findByText("the thread gave up");
    slot.lifecycle.unmount();
  });
});

describe("an issue and its code", () => {
  const detailPath = "pr/acme/app/7/f/f1";

  it("shows the full detail above the code", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    await slot.findByText("Off by one");
    await slot.findByText("The loop walks the buffer.");
    await slot.findByText("It runs one past the end.");
    await slot.findByText("Use < instead of <=.");
    const box = await slot.findByLabelText("Comment for Off by one");
    expect((box as HTMLTextAreaElement).value).toBe("Please fix the bound here.");
    slot.lifecycle.unmount();
  });

  it("asks for the code with a small amount of context by default", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    await slot.findByText("const x = 1;");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getFindingCode");
    expect(call?.input).toEqual({ findingId: "f1", context: 3 });
    slot.lifecycle.unmount();
  });

  it("numbers snippet lines by their real position in the file", async () => {
    // The whole value of this view is that the numbers match the finding.
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    await slot.findByText("const x = 1;");
    for (const lineNumber of ["9", "10", "11", "12", "13"]) {
      await slot.findByText(lineNumber);
    }
    expect(slot.queryByText("1")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("stacks every file the issue points at, with the reference's note", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    await slot.findByText("src/a.ts:10-12");
    await slot.findByText("src/other.ts:20");
    await slot.findByText("the pattern this should match");
    await slot.findByText("retry(() => run());");
    slot.lifecycle.unmount();
  });

  it("links each file to its place in the PR diff on GitHub", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    const link = await slot.findByText("src/a.ts:10-12");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7/files#diff-abc123R10",
    );
    slot.lifecycle.unmount();
  });

  it("says why a file could not be shown instead of rendering nothing", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
      {
        rpc: rpc({
          getFindingCode: () => ({
            prUrl: CODE.prUrl,
            locations: [
              { ...CODE.locations[0], lines: [], error: "404 Not Found at c5b7b2a7bc42" },
            ],
          }),
        }),
      },
    );
    await slot.findByText("404 Not Found at c5b7b2a7bc42");
    slot.lifecycle.unmount();
  });

  it("explains a finding that a re-run has replaced", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7/f/gone" },
      { rpc: rpc() },
    );
    await slot.findByText("This issue is gone");
    slot.lifecycle.unmount();
  });

  it("shows a posted issue as a link rather than an editable draft", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [
              {
                ...FINDING,
                state: "posted",
                commentUrl: "https://github.com/acme/app/pull/7#c1",
              },
            ],
          }),
        }),
      },
    );
    await slot.findByText("View on GitHub");
    expect(slot.queryByLabelText("Comment for Off by one")).toBeNull();
    slot.lifecycle.unmount();
  });
});

describe("the discussion tab", () => {
  it("explains itself before a discussion is opened", async () => {
    const app = await load();
    const tab = app.navPanels[0]?.fixedTabs?.[0];
    const slot = renderSlot(tab!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("No discussion open");
    slot.lifecycle.unmount();
  });
});

describe("remembering where you were", () => {
  it("restores the saved repo and filter instead of asking again", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: rpc({
          status: () => ({ ...READY, repos: ["acme/other", "acme/app"] }),
          getPanelState: () => ({
            repo: "acme/app",
            filter: { kind: "team", teamSlug: "acme/core" },
          }),
        }),
      },
    );
    await slot.findByText("Add a thing");
    const listCall = slot.inspection.rpcCalls
      .filter((entry) => entry.method === "listPullRequests")
      .at(-1);
    // Not "acme/other" (the first repo) and not the default "mine" filter.
    expect(listCall?.input).toEqual({
      repo: "acme/app",
      filter: { kind: "team", teamSlug: "acme/core" },
    });
    slot.lifecycle.unmount();
  });

  it("falls back to the first repo when nothing was saved", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    const listCall = slot.inspection.rpcCalls
      .filter((entry) => entry.method === "listPullRequests")
      .at(-1);
    expect(listCall?.input).toEqual({ repo: "acme/app", filter: { kind: "mine" } });
    slot.lifecycle.unmount();
  });

  it("drops a saved repo the plugin no longer knows about", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      { rpc: rpc({ getPanelState: () => ({ repo: "acme/removed", filter: null }) }) },
    );
    await slot.findByText("Add a thing");
    const listCall = slot.inspection.rpcCalls
      .filter((entry) => entry.method === "listPullRequests")
      .at(-1);
    expect((listCall?.input as { repo: string }).repo).toBe("acme/app");
    slot.lifecycle.unmount();
  });

  it("saves the filter when the user changes it", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    const allTab = (await slot.findByText("All open")).closest("button") as HTMLElement;
    // Radix tabs activate on mousedown, not click.
    fireEvent.mouseDown(allTab);
    fireEvent.focus(allTab);
    fireEvent.click(allTab);
    await waitFor(() => {
      const saved = slot.inspection.rpcCalls.find((entry) => entry.method === "setPanelState");
      expect((saved?.input as { filter: { kind: string } })?.filter?.kind).toBe("all");
    });
    slot.lifecycle.unmount();
  });
});

describe("links out to GitHub", () => {
  const detailPath = "pr/acme/app/7/f/f1";

  it("opens through BB's URL routing rather than a raw navigation", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
      { rpc: rpc(), openUrl: () => true },
    );
    const link = await slot.findByText("src/a.ts:10-12");
    fireEvent.click(link.closest("a") ?? link);
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({
          method: "openUrl",
          url: "https://github.com/acme/app/pull/7/files#diff-abc123R10",
        }),
      );
    });
    slot.lifecycle.unmount();
  });

  it("routes the PR link too", async () => {
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7" },
      { rpc: rpc(), openUrl: () => true },
    );
    const link = await slot.findByText("Open on GitHub");
    fireEvent.click(link.closest("a") ?? link);
    await waitFor(() => {
      expect(slot.inspection.navigateCalls).toContainEqual(
        expect.objectContaining({ method: "openUrl", url: "https://github.com/acme/app/pull/7" }),
      );
    });
    slot.lifecycle.unmount();
  });

  it("keeps a real href so the link can be copied or opened in a new tab", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: detailPath }, { rpc: rpc() });
    const link = await slot.findByText("src/a.ts:10-12");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7/files#diff-abc123R10",
    );
    slot.lifecycle.unmount();
  });

  it("leaves a modifier-click to the browser", async () => {
    // Cmd-click means "new tab"; swallowing it would be worse than useless.
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
      { rpc: rpc(), openUrl: () => true },
    );
    const link = await slot.findByText("src/a.ts:10-12");
    fireEvent.click(link.closest("a") ?? link, { metaKey: true });
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });
});

describe("remembering the repo when status is slow", () => {
  it("keeps the saved repo even though the repo list arrives later", async () => {
    // Reproduction: in production `status` runs a gh auth probe and a teams
    // lookup, so it lands seconds after `getPanelState`. The saved repo must
    // not be discarded in the gap while the repo list is still empty.
    const app = await load();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "" },
      {
        rpc: rpc({
          status: async () => {
            await new Promise((resolve) => setTimeout(resolve, 40));
            return { ...READY, repos: ["acme/other", "acme/app"] };
          },
          getPanelState: () => ({ repo: "acme/app", filter: { kind: "mine" } }),
        }),
      },
    );
    await slot.findByText("Add a thing");
    const listCall = slot.inspection.rpcCalls
      .filter((entry) => entry.method === "listPullRequests")
      .at(-1);
    expect((listCall?.input as { repo: string }).repo).toBe("acme/app");
    slot.lifecycle.unmount();
  });
});

describe("the comment to post", () => {
  const detailPath = "pr/acme/app/7/f/f1";

  const withFinding = async (overrides: Partial<FindingDto>) => {
    const app = await load();
    return renderSlot(
      app.navPanels[0]!,
      { subPath: detailPath },
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            review: REVIEW,
            findings: [{ ...FINDING, ...overrides }],
          }),
        }),
      },
    );
  };

  it("says which file and line range the comment lands on", async () => {
    const slot = await withFinding({});
    await slot.findByText("on src/a.ts, lines 10–12");
    slot.lifecycle.unmount();
  });

  it("says a single line as a line, not a range", async () => {
    const slot = await withFinding({ startLine: 10, endLine: 10 });
    await slot.findByText("on src/a.ts, line 10");
    slot.lifecycle.unmount();
  });

  it("treats a null endLine as a single line", async () => {
    const slot = await withFinding({ startLine: 10, endLine: null });
    await slot.findByText("on src/a.ts, line 10");
    slot.lifecycle.unmount();
  });

  it("says when the anchor is on the old side of the diff", async () => {
    const slot = await withFinding({ side: "LEFT", startLine: 4, endLine: 4 });
    await slot.findByText("on src/a.ts, line 4 of the old file");
    slot.lifecycle.unmount();
  });

  it("warns when the comment can only be a general PR comment", async () => {
    // Without a line anchor, "Post comment" silently becomes an issue comment;
    // the reviewer should know that before pressing it.
    const slot = await withFinding({ startLine: null, endLine: null });
    await slot.findByText(
      "as a general comment on the pull request — this issue has no line anchor",
    );
    slot.lifecycle.unmount();
  });

  it("links the target to that spot in the PR diff", async () => {
    const slot = await withFinding({});
    const link = await slot.findByText("on src/a.ts, lines 10–12");
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7/files#diff-abc123R10",
    );
    slot.lifecycle.unmount();
  });

  it("says where a posted comment went, in the past tense", async () => {
    const slot = await withFinding({
      state: "posted",
      commentUrl: "https://github.com/acme/app/pull/7#c1",
    });
    await slot.findByText("Posted comment");
    await slot.findByText("on src/a.ts, lines 10–12");
    slot.lifecycle.unmount();
  });

  it("lets the box grow to the whole comment instead of clipping it", async () => {
    // Regression: `rows` was computed from newline count, so a long wrapped
    // one-paragraph comment — the usual shape — rendered three rows tall.
    const long = "A very long single-line review comment. ".repeat(30);
    const slot = await withFinding({ suggestedComment: long, draftComment: null });
    const box = (await slot.findByLabelText("Comment for Off by one")) as HTMLTextAreaElement;
    expect(box.value).toBe(long);
    // Height is driven by content, not by a fixed row count.
    expect(box.getAttribute("rows")).toBe("1");
    expect(box.className).toContain("overflow-hidden");
    slot.lifecycle.unmount();
  });
});
