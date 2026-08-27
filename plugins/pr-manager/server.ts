import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract } from "./contract.js";

const statusSchema = z.enum(["WAITING", "FAILING", "FEEDBACK", "APPROVED", "MERGED"]);
const pullRequestSchema = z.object({
  key: z.string(), repository: z.string(), number: z.number().int().positive(),
  title: z.string(), url: z.string().url(), status: statusSchema, summary: z.string(),
  isDraft: z.boolean(), headRefName: z.string(), baseRefName: z.string(),
  createdAt: z.string(), updatedAt: z.string(), mergedAt: z.string().nullable(), projectId: z.string().nullable(),
  projectName: z.string().nullable(), threadId: z.string().nullable(), threadTitle: z.string().nullable(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

const pullRequestListSchema = z.object({ prs: z.array(pullRequestSchema), refreshedAt: z.string().nullable() });
type PullRequestList = z.infer<typeof pullRequestListSchema>;

export const rpcContract = defineRpcContract({
  prs_list: { input: z.null(), output: pullRequestListSchema },
  prs_refresh: { input: z.null(), output: pullRequestListSchema },
  prs_create_thread: {
    input: z.object({
      repository: z.string(), number: z.number().int().positive(), title: z.string(),
      url: z.string().url(), headRefName: z.string(), baseRefName: z.string(), projectId: z.string(),
    }),
    output: z.object({ threadId: z.string() }),
  },
});

function normalizeGitHubRepository(remote: string | null): string | null {
  if (remote === null) return null;
  const cleaned = remote.trim().replace(/\.git$/, "").replace(/^ssh:\/\//, "");
  const match = cleaned.match(/(?:git@|https?:\/\/)?github\.com[:/]([^/]+\/[^/]+)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

const linkKey = (repository: string, number: number) => `thread:${repository.toLowerCase()}#${number}`;
const PR_LIST_CACHE_KEY = "pull-request-list-v2";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    mergedWithinDays: {
      type: "select", label: "Keep merged PRs visible", options: ["7", "14", "30"], default: "14",
    },
    maximumPullRequests: {
      type: "select", label: "Maximum PRs per status", options: ["25", "50", "100"], default: "50",
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function projectAndThreadContext() {
    const projects = await bb.sdk.projects.list();
    const allThreads = (await Promise.all(projects.flatMap((project) => [
      bb.sdk.threads.list({ projectId: project.id, archived: false, limit: 500 }),
      bb.sdk.threads.list({ projectId: project.id, archived: true, limit: 500 }),
    ]))).flat();
    return { projects, allThreads };
  }

  async function readCachedPullRequests(): Promise<PullRequestList> {
    const cached = await bb.storage.kv.get<unknown>(PR_LIST_CACHE_KEY);
    const parsed = pullRequestListSchema.safeParse(cached);
    return parsed.success ? parsed.data : { prs: [], refreshedAt: null };
  }

  async function refreshPullRequests(): Promise<PullRequestList> {
    const [{ mergedWithinDays, maximumPullRequests }, hosts, context] = await Promise.all([
      settings.get(), bb.sdk.hosts.list(), projectAndThreadContext(),
    ]);
    const connected = hosts.filter((candidate) => candidate.status === "connected");
    if (connected.length === 0) throw new Error("No connected BB machine is available.");
    const projectHostIds = new Set(context.projects.flatMap((project) => project.sources.map((source) => source.hostId)));
    const queryHost = connected.find((candidate) => projectHostIds.has(candidate.id)) ?? connected[0]!;
    const raw = await host.call("listPullRequests", {
      mergedWithinDays: Number(mergedWithinDays), maximumPullRequests: Number(maximumPullRequests),
    }, { hostId: queryHost.id });

    const projectByRepository = new Map<string, (typeof context.projects)[number]>();
    const usableThreads = context.allThreads.filter((thread) => thread.status !== "error");
    for (const project of context.projects) {
      const repository = normalizeGitHubRepository(project.gitRemoteUrl);
      if (repository !== null && !projectByRepository.has(repository)) projectByRepository.set(repository, project);
    }
    const prs: PullRequest[] = [];
    for (const pr of raw.pullRequests) {
      const project = projectByRepository.get(pr.repository.toLowerCase()) ?? null;
      let thread = null;
      const storedThreadId = await bb.storage.kv.get<string>(linkKey(pr.repository, pr.number));
      if (storedThreadId !== null) thread = usableThreads.find((candidate) => candidate.id === storedThreadId) ?? null;
      if (thread === null && project !== null) {
        thread = usableThreads.find((candidate) =>
          candidate.projectId === project.id && candidate.environmentBranchName === pr.headRefName) ?? null;
      }
      if (thread === null && project !== null) {
        const repositoryNumber = `${pr.repository.toLowerCase()}#${pr.number}`;
        const numberPattern = new RegExp(`#${pr.number}(?:\\b|:)`);
        thread = usableThreads.find((candidate) => {
          if (candidate.projectId !== project.id) return false;
          const title = (candidate.title ?? candidate.titleFallback ?? "").toLowerCase();
          return title.includes(repositoryNumber) || numberPattern.test(title);
        }) ?? null;
      }
      prs.push({
        ...pr, key: `${pr.repository}#${pr.number}`, projectId: project?.id ?? null,
        projectName: project?.name ?? null, threadId: thread?.id ?? null,
        threadTitle: thread?.title ?? thread?.titleFallback ?? null,
      });
    }
    const result = { prs, refreshedAt: new Date().toISOString() };
    await bb.storage.kv.set(PR_LIST_CACHE_KEY, result);
    return result;
  }

  bb.rpc.register(rpcContract, {
    prs_list: () => readCachedPullRequests(),
    prs_refresh: () => refreshPullRequests(),
    prs_create_thread: async (input) => {
      const projects = await bb.sdk.projects.list();
      const project = projects.find((candidate) => candidate.id === input.projectId);
      if (project === undefined) throw new Error("The matching BB project no longer exists.");
      if (normalizeGitHubRepository(project.gitRemoteUrl) !== input.repository.toLowerCase()) {
        throw new Error("The selected project does not match this pull request repository.");
      }
      const existing = (await readCachedPullRequests()).prs.find((candidate) =>
        candidate.repository === input.repository && candidate.number === input.number);
      if (existing?.threadId !== null && existing?.threadId !== undefined) {
        try {
          const existingThread = await bb.sdk.threads.get({ threadId: existing.threadId });
          if (existingThread.status !== "error") return { threadId: existing.threadId };
        } catch {
          // A missing or failed thread is stale linkage. Provision a replacement.
        }
      }

      const source = project.sources.find((candidate) => candidate.isDefault) ?? project.sources[0];
      if (source === undefined) throw new Error("The matching BB project has no workspace source.");
      const prepared = await host.call("preparePullRequestBranch", {
        projectPath: source.path, repository: input.repository, number: input.number,
      }, { hostId: source.hostId });
      const thread = await bb.sdk.threads.spawn({
        projectId: project.id,
        environment: {
          type: "host", hostId: source.hostId,
          workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: prepared.ref } },
        },
        prompt: [
          `Work on pull request ${input.url}.`,
          "Review its current CI and reviewer feedback, summarize what needs attention, and help address it.",
          `The worktree starts from the PR head; target branch is ${input.baseRefName}.`,
        ].join("\n\n"),
        title: `PR #${input.number}: ${input.title}`,
        origin: "plugin",
      });
      await bb.storage.kv.set(linkKey(input.repository, input.number), thread.id);
      const cached = await readCachedPullRequests();
      if (cached.refreshedAt !== null) {
        await bb.storage.kv.set(PR_LIST_CACHE_KEY, {
          ...cached,
          prs: cached.prs.map((pr) => pr.repository === input.repository && pr.number === input.number
            ? { ...pr, threadId: thread.id, threadTitle: thread.title ?? thread.titleFallback ?? null }
            : pr),
        });
      }
      bb.realtime.publish("prs-changed", { key: `${input.repository}#${input.number}` });
      return { threadId: thread.id };
    },
  });

  bb.cli.register({
    name: "pr-manager", summary: "List pull requests tracked by PR Manager",
    commands: [
      { name: "list", summary: "List cached PR statuses", usage: "bb pr-manager list [--json]" },
      { name: "refresh", summary: "Refresh PR statuses from GitHub", usage: "bb pr-manager refresh [--json]" },
    ],
    async run(argv) {
      if (argv[0] !== "list" && argv[0] !== "refresh") {
        return { exitCode: 1, stderr: "Usage: bb pr-manager <list|refresh> [--json]" };
      }
      const result = argv[0] === "refresh" ? await refreshPullRequests() : await readCachedPullRequests();
      if (argv.includes("--json")) return { exitCode: 0, stdout: JSON.stringify(result) };
      return { exitCode: 0, stdout: result.refreshedAt === null ? "No cached pull requests. Run `bb pr-manager refresh`." : result.prs.length === 0 ? "No current pull requests." : result.prs
        .map((pr) => `${pr.status.padEnd(8)} ${pr.repository}#${pr.number}  ${pr.title}\n         ${pr.summary}`).join("\n") };
    },
  });
  bb.log.info("loaded");
}
