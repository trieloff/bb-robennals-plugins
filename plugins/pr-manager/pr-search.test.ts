import { describe, expect, it } from "vitest";
import { mergedPullRequestSearchArgs, openPullRequestSearchArgs } from "./pr-search.js";

describe("pull request search arguments", () => {
  it("excludes archived repositories from both searches", () => {
    // A PR in an archived repository cannot be acted on, so it must not be listed.
    expect(openPullRequestSearchArgs(50)).toContain("--archived=false");
    expect(mergedPullRequestSearchArgs("2026-08-01", 50)).toContain("--archived=false");
  });

  it("keeps the state and date filters each search needs", () => {
    expect(openPullRequestSearchArgs(50)).toEqual(["search", "prs", "--author=@me", "--archived=false",
      "--state=open", "--limit=50", "--sort=updated", "--order=desc", "--json",
      "number,title,url,repository,createdAt,updatedAt,isDraft"]);
    expect(mergedPullRequestSearchArgs("2026-08-01", 25)).toEqual(["search", "prs", "--author=@me", "--archived=false",
      "--merged", "--merged-at=>=2026-08-01", "--limit=25", "--sort=updated", "--order=desc", "--json",
      "number,title,url,repository,createdAt,updatedAt,isDraft"]);
  });
});
