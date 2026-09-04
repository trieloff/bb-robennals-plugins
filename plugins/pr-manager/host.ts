import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { pullRequestSourceRef } from "./git-ref.js";
import { mergedPullRequestQuery, openPullRequestQuery, pullRequestSearchArgs } from "./pr-search.js";
import { classifyPullRequest, summarizePullRequest } from "./pr-status.js";

const execFileAsync = promisify(execFile);
interface CheckContext { status?: string; conclusion?: string; state?: string }
interface StatusCheckRollup { state?: string; contexts: { totalCount: number; nodes: CheckContext[] } }
interface SearchResult {
  number: number; title: string; url: string; state: string; isDraft: boolean; headRefName: string; baseRefName: string;
  createdAt: string; updatedAt: string; mergedAt: string | null; reviewDecision: string | null;
  repository: { nameWithOwner: string };
  reviewRequests: { nodes: Array<{ requestedReviewer: { login?: string; slug?: string } | null }> };
  commits: { nodes: Array<{ commit: { statusCheckRollup: StatusCheckRollup | null } }> };
}
async function run(command: string, args: string[], signal: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000, signal });
    return stdout;
  } catch (cause) {
    const error = cause as Error & { stderr?: string };
    throw new Error(`${command} failed: ${error.stderr?.trim() || error.message}`);
  }
}
async function search(query: string, limit: number, signal: AbortSignal): Promise<SearchResult[]> {
  const parsed = JSON.parse(await run("gh", pullRequestSearchArgs(query, limit), signal)) as
    { data: { search: { nodes: Array<Partial<SearchResult>> } } };
  // `type: ISSUE` is the only search type that returns pull requests, so any
  // node that is a plain issue comes back as the empty half of the fragment.
  return parsed.data.search.nodes.filter((node): node is SearchResult => typeof node.number === "number");
}
function rollupChecks(rollup: StatusCheckRollup | null | undefined): CheckContext[] {
  if (!rollup) return [];
  // A head commit with more than one page of contexts would otherwise be
  // classified from the first page alone, hiding a failure further down. The
  // rollup's own state is computed over every context, so when the page is
  // short one synthetic check stands in for the contexts not fetched — cheaper,
  // and far less fragile, than paginating a connection per pull request.
  const truncated = rollup.contexts.totalCount > rollup.contexts.nodes.length;
  return truncated ? [...rollup.contexts.nodes, { state: rollup.state }] : rollup.contexts.nodes;
}
function normalizeCheck(check: CheckContext) {
  const state = check.conclusion ?? check.state ?? "";
  const status = check.status ?? (state === "PENDING" || state === "EXPECTED" ? "IN_PROGRESS" : "COMPLETED");
  return { status: status.toUpperCase(), conclusion: state.toUpperCase() };
}
function normalizeRemote(remote: string): string | null {
  const cleaned = remote.trim().replace(/\.git$/, "").replace(/^ssh:\/\//, "");
  return cleaned.match(/(?:git@|https?:\/\/)?github\.com[:/]([^/]+\/[^/]+)$/i)?.[1]?.toLowerCase() ?? null;
}
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async listPullRequests({ mergedWithinDays, maximumPullRequests }, context) {
      await run("gh", ["auth", "status"], context.signal);
      const since = new Date(Date.now() - mergedWithinDays * 86_400_000).toISOString().slice(0, 10);
      const [open, merged] = await Promise.all([
        search(openPullRequestQuery(), maximumPullRequests, context.signal),
        search(mergedPullRequestQuery(since), maximumPullRequests, context.signal),
      ]);
      const unique = [...new Map([...open, ...merged].map((pr) => [pr.url, pr])).values()];
      const pullRequests = unique.map((view) => {
        const requestedReviewers = view.reviewRequests.nodes
          .map((request) => request.requestedReviewer?.login ?? request.requestedReviewer?.slug)
          .filter((name): name is string => name !== undefined);
        const input = { state: view.state, mergedAt: view.mergedAt, isDraft: view.isDraft, reviewDecision: view.reviewDecision ?? "",
          requestedReviewers, checks: rollupChecks(view.commits.nodes[0]?.commit.statusCheckRollup).map(normalizeCheck) };
        const status = classifyPullRequest(input);
        return { repository: view.repository.nameWithOwner, number: view.number, title: view.title, url: view.url, status,
          summary: summarizePullRequest(input, status), isDraft: view.isDraft, headRefName: view.headRefName,
          baseRefName: view.baseRefName, createdAt: view.createdAt, updatedAt: view.updatedAt, mergedAt: view.mergedAt };
      });
      const priority = { FAILING: 0, FEEDBACK: 1, WAITING: 2, APPROVED: 3, MERGED: 4 } as const;
      pullRequests.sort((a, b) => priority[a.status] - priority[b.status] || b.updatedAt.localeCompare(a.updatedAt));
      return { pullRequests };
    },
    async preparePullRequestBranch({ projectPath, repository, number }, context) {
      const remote = await run("git", ["-C", projectPath, "remote", "get-url", "origin"], context.signal);
      if (normalizeRemote(remote) !== repository.toLowerCase()) throw new Error(`Project origin does not match ${repository}.`);
      // Keep the PR head outside refs/remotes. BB refreshes and prunes the
      // project's remote-tracking refs before provisioning a worktree.
      const ref = pullRequestSourceRef(number);
      await run("git", ["-C", projectPath, "fetch", "--force", "origin", `+refs/pull/${number}/head:${ref}`], context.signal);
      return { ref };
    },
  },
});
