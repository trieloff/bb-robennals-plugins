import { describe, expect, it } from "vitest";
import { pullRequestSourceRef } from "./git-ref.js";

describe("pullRequestSourceRef", () => {
  it("uses a private ref that remote pruning cannot remove", () => {
    expect(pullRequestSourceRef(5622)).toBe("refs/bb/pr-manager/pull/5622");
    expect(pullRequestSourceRef(5622)).not.toContain("refs/remotes/");
  });

  it("rejects invalid pull request numbers", () => {
    expect(() => pullRequestSourceRef(0)).toThrow("positive integer");
    expect(() => pullRequestSourceRef(1.5)).toThrow("positive integer");
  });
});
