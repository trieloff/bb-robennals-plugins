// @vitest-environment jsdom
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
  background: "The loop walks the buffer.",
  problem: "It runs one past the end.",
  suggestedFix: "Use < instead of <=.",
  suggestedComment: "Please fix the bound here.",
  draftComment: null,
  state: "open",
  commentUrl: null,
  postedAt: null,
  discussionThreadId: null,
};

/** The panel's RPC surface, with per-test overrides. */
function rpc(overrides: Record<string, unknown> = {}) {
  return {
    status: () => READY,
    listPullRequests: () => ({ pullRequests: [PR] }),
    getPullRequest: () => ({
      pullRequest: PR,
      body: "",
      files: [],
      diffError: null,
      review: REVIEW,
      findings: [FINDING],
    }),
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

describe("the pull request view", () => {
  it("deep-links to a PR through the panel's subPath", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await slot.findByText("Add a thing");
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "getPullRequest");
    expect(call?.input).toEqual({ repo: "acme/app", number: 7 });
    slot.lifecycle.unmount();
  });

  it("shows every part of a finding, not just the comment", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "pr/acme/app/7" }, { rpc: rpc() });
    await slot.findByText("Off by one");
    await slot.findByText("src/a.ts:10-12 · correctness");
    await slot.findByText("The loop walks the buffer.");
    await slot.findByText("It runs one past the end.");
    await slot.findByText("Use < instead of <=.");
    // The comment is editable, seeded with the suggestion.
    const box = await slot.findByLabelText("Comment for Off by one");
    expect((box as HTMLTextAreaElement).value).toBe("Please fix the bound here.");
    slot.lifecycle.unmount();
  });

  it("shows a posted finding as a link rather than an editable draft", async () => {
    const app = await load();
    const posted: FindingDto = {
      ...FINDING,
      state: "posted",
      commentUrl: "https://github.com/acme/app/pull/7#c1",
    };
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "pr/acme/app/7" },
      {
        rpc: rpc({
          getPullRequest: () => ({
            pullRequest: PR,
            body: "",
            files: [],
            diffError: null,
            review: REVIEW,
            findings: [posted],
          }),
        }),
      },
    );
    await slot.findByText("View on GitHub");
    expect(slot.queryByLabelText("Comment for Off by one")).toBeNull();
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
            body: "",
            files: [],
            diffError: null,
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
            body: "",
            files: [],
            diffError: null,
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

describe("the discussion tab", () => {
  it("explains itself before a discussion is opened", async () => {
    const app = await load();
    const tab = app.navPanels[0]?.fixedTabs?.[0];
    const slot = renderSlot(tab!, { subPath: "" }, { rpc: rpc() });
    await slot.findByText("No discussion open");
    slot.lifecycle.unmount();
  });
});
