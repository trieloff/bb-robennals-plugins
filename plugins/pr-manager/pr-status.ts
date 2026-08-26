export type PullRequestStatus = "WAITING" | "FAILING" | "FEEDBACK" | "APPROVED" | "MERGED";
export interface PullRequestStatusInput {
  state: string; mergedAt: string | null; isDraft: boolean; reviewDecision: string;
  requestedReviewers: string[]; checks: Array<{ status: string; conclusion: string }>;
}
const FAILING_CONCLUSIONS = new Set(["ACTION_REQUIRED", "CANCELLED", "FAILURE", "STARTUP_FAILURE", "STALE", "TIMED_OUT"]);
export function classifyPullRequest(input: PullRequestStatusInput): PullRequestStatus {
  if (input.state === "MERGED" || input.mergedAt !== null) return "MERGED";
  if (input.checks.some((check) => FAILING_CONCLUSIONS.has(check.conclusion))) return "FAILING";
  if (input.reviewDecision === "CHANGES_REQUESTED") return "FEEDBACK";
  if (input.reviewDecision === "APPROVED" && input.requestedReviewers.length === 0) return "APPROVED";
  return "WAITING";
}
export function summarizePullRequest(input: PullRequestStatusInput, status: PullRequestStatus): string {
  const failing = input.checks.filter((check) => FAILING_CONCLUSIONS.has(check.conclusion)).length;
  const pending = input.checks.filter((check) => check.status !== "COMPLETED").length;
  switch (status) {
    case "MERGED": return input.mergedAt === null ? "Merged" : `Merged ${input.mergedAt.slice(0, 10)}`;
    case "FAILING": return `${failing} ${failing === 1 ? "check is" : "checks are"} failing`;
    case "FEEDBACK": return "Changes requested; feedback needs a response";
    case "APPROVED": return "Approved; all requested reviews are complete";
    case "WAITING": {
      const review = input.requestedReviewers.length > 0 ? `Waiting for ${input.requestedReviewers.join(", ")}` : "Waiting for review";
      if (input.isDraft) return `Draft · ${review}`;
      return pending > 0 ? `${review} · ${pending} ${pending === 1 ? "check" : "checks"} running` : review;
    }
  }
}
