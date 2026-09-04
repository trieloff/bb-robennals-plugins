import { describe, expect, it } from "vitest";
import {
  mergedPullRequestQuery, openPullRequestQuery, PULL_REQUEST_SEARCH_DOCUMENT, pullRequestSearchArgs,
} from "./pr-search.js";

describe("pull request search", () => {
  it("excludes archived repositories from both searches", () => {
    // A PR in an archived repository cannot be acted on, so it must not be listed.
    expect(openPullRequestQuery()).toContain("archived:false");
    expect(mergedPullRequestQuery("2026-08-01")).toContain("archived:false");
  });

  it("keeps the state and date filters each search needs", () => {
    expect(openPullRequestQuery()).toBe("author:@me is:pr archived:false state:open sort:updated-desc");
    expect(mergedPullRequestQuery("2026-08-01")).toBe(
      "author:@me is:pr archived:false is:merged merged:>=2026-08-01 sort:updated-desc",
    );
  });

  it("asks for every field the list needs in one request", () => {
    const args = pullRequestSearchArgs(openPullRequestQuery(), 50);
    expect(args.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(args).toContain("q=author:@me is:pr archived:false state:open sort:updated-desc");
    expect(args).toContain("limit=50");
    // Losing any of these sends the handler back to a per-PR `gh pr view`.
    const document = args.find((arg) => arg.startsWith("query=")) ?? "";
    for (const field of ["reviewDecision", "reviewRequests", "statusCheckRollup", "mergedAt", "isDraft"]) {
      expect(document).toContain(field);
    }
  });

  it("selects every kind of requested reviewer", () => {
    // A pending Bot review — a Copilot review request — keeps a PR out of
    // APPROVED, so dropping the fragment would mis-classify it.
    const document = PULL_REQUEST_SEARCH_DOCUMENT;
    for (const fragment of ["on User", "on Team", "on Bot", "on Mannequin"]) {
      expect(document).toContain(fragment);
    }
  });

  it("can tell a truncated check rollup from a complete one", () => {
    // Without totalCount and the rollup state, a commit with more than one page
    // of contexts is classified from its first page alone.
    expect(PULL_REQUEST_SEARCH_DOCUMENT).toContain("totalCount");
    expect(PULL_REQUEST_SEARCH_DOCUMENT).toMatch(/statusCheckRollup \{ state/);
  });
});
