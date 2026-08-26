import { describe, expect, it } from "vitest";
import { classifyPullRequest, summarizePullRequest, type PullRequestStatusInput } from "./pr-status.js";
const base = (overrides: Partial<PullRequestStatusInput> = {}): PullRequestStatusInput => ({
  state: "OPEN", mergedAt: null, isDraft: false, reviewDecision: "REVIEW_REQUIRED",
  requestedReviewers: ["octocat"], checks: [{ status: "COMPLETED", conclusion: "SUCCESS" }], ...overrides,
});
describe("classifyPullRequest", () => {
  it("uses the intended status priority", () => {
    expect(classifyPullRequest(base({ mergedAt: "2026-08-20T10:00:00Z", checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] }))).toBe("MERGED");
    expect(classifyPullRequest(base({ reviewDecision: "CHANGES_REQUESTED", checks: [{ status: "COMPLETED", conclusion: "FAILURE" }] }))).toBe("FAILING");
    expect(classifyPullRequest(base({ reviewDecision: "CHANGES_REQUESTED" }))).toBe("FEEDBACK");
    expect(classifyPullRequest(base({ reviewDecision: "APPROVED", requestedReviewers: [] }))).toBe("APPROVED");
    expect(classifyPullRequest(base())).toBe("WAITING");
  });
  it("keeps partially requested approvals waiting", () => {
    expect(classifyPullRequest(base({ reviewDecision: "APPROVED", requestedReviewers: ["hubot"] }))).toBe("WAITING");
  });
  it("summarizes pending checks and requested reviewers", () => {
    const input = base({ checks: [{ status: "IN_PROGRESS", conclusion: "" }] });
    expect(summarizePullRequest(input, "WAITING")).toBe("Waiting for octocat · 1 check running");
  });
});
