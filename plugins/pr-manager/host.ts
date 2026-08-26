import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import { pullRequestSourceRef } from "./git-ref.js";
import { classifyPullRequest, summarizePullRequest } from "./pr-status.js";

const execFileAsync = promisify(execFile);
interface SearchResult { number: number; title: string; url: string; isDraft: boolean; createdAt: string; updatedAt: string; repository: { nameWithOwner: string } }
interface PrView {
  number: number; title: string; url: string; state: string; isDraft: boolean; headRefName: string; baseRefName: string;
  reviewDecision: string | null; reviewRequests: Array<{ login?: string; name?: string; slug?: string }>;
  statusCheckRollup: Array<{ status?: string; conclusion?: string; state?: string }>; createdAt: string; updatedAt: string; mergedAt: string | null;
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
async function mapConcurrent<T, R>(values: T[], limit: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length); let cursor = 0;
  async function worker() { while (cursor < values.length) { const index = cursor++; results[index] = await mapper(values[index]!); } }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}
async function search(args: string[], signal: AbortSignal): Promise<SearchResult[]> {
  return JSON.parse(await run("gh", ["search", "prs", "--author=@me", ...args, "--json", "number,title,url,repository,createdAt,updatedAt,isDraft"], signal)) as SearchResult[];
}
function normalizeCheck(check: PrView["statusCheckRollup"][number]) {
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
        search(["--state=open", "--sort=updated", "--order=desc", `--limit=${maximumPullRequests}`], context.signal),
        search(["--merged", `--merged-at=>=${since}`, "--sort=updated", "--order=desc", `--limit=${maximumPullRequests}`], context.signal),
      ]);
      const unique = [...new Map([...open, ...merged].map((pr) => [pr.url, pr])).values()];
      const pullRequests = await mapConcurrent(unique, 6, async (result) => {
        const repository = result.repository.nameWithOwner;
        const view = JSON.parse(await run("gh", ["pr", "view", String(result.number), "--repo", repository,
          "--json", "number,title,url,state,isDraft,headRefName,baseRefName,reviewDecision,reviewRequests,statusCheckRollup,createdAt,updatedAt,mergedAt"], context.signal)) as PrView;
        const requestedReviewers = view.reviewRequests.map((reviewer) => reviewer.login ?? reviewer.name ?? reviewer.slug)
          .filter((name): name is string => name !== undefined);
        const input = { state: view.state, mergedAt: view.mergedAt, isDraft: view.isDraft, reviewDecision: view.reviewDecision ?? "",
          requestedReviewers, checks: view.statusCheckRollup.map(normalizeCheck) };
        const status = classifyPullRequest(input);
        return { repository, number: view.number, title: view.title, url: view.url, status,
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
