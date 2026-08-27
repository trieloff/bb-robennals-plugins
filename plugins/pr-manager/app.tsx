import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PullRequest, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const statusStyle: Record<PullRequest["status"], string> = {
  WAITING: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  FAILING: "border-destructive/30 bg-destructive/10 text-destructive",
  FEEDBACK: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  APPROVED: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  MERGED: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
};
function StatusBadge({ status, count }: { status: PullRequest["status"]; count?: number }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide", statusStyle[status])}>
      <span>{status}</span>
      {count === undefined ? null : <span className="tabular-nums opacity-80">{count}</span>}
    </span>
  );
}
function PullRequestRow({ pr, onChanged }: { pr: PullRequest; onChanged: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createThread = async () => {
    if (pr.projectId === null || creating) return;
    setCreating(true); setError(null);
    try {
      const result = await rpc.call("prs_create_thread", {
        repository: pr.repository, number: pr.number, title: pr.title, url: pr.url,
        headRefName: pr.headRefName, baseRefName: pr.baseRefName, projectId: pr.projectId,
      });
      onChanged();
      navigate.toThread(result.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setCreating(false); }
  };
  return (
    <article className="rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={pr.status} />
            <span className="text-xs text-muted-foreground">{pr.repository} #{pr.number}</span>
            {pr.isDraft ? <span className="text-xs text-muted-foreground">Draft</span> : null}
          </div>
          <h2 className="mt-1.5 text-sm font-medium leading-5 text-foreground">{pr.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{pr.summary}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{pr.headRefName} → {pr.baseRefName}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {pr.threadId !== null && pr.projectId !== null ? (
            <Button size="sm" onClick={() => void createThread()} disabled={creating}>
              <Icon name={creating ? "Loading" : "MessageSquare"} className={cn("size-4", creating && "animate-spin")} />
              {creating ? "Opening…" : "Open thread"}
            </Button>
          ) : pr.threadId !== null ? (
            <Button size="sm" onClick={() => navigate.toThread(pr.threadId!)}><Icon name="MessageSquare" className="size-4" />Open thread</Button>
          ) : pr.projectId !== null && pr.status !== "MERGED" ? (
            <Button size="sm" onClick={() => void createThread()} disabled={creating}>
              <Icon name={creating ? "Loading" : "GitBranch"} className={cn("size-4", creating && "animate-spin")} />
              {creating ? "Creating…" : "Create thread"}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => navigate.openUrl(pr.url)} aria-label={`Open ${pr.repository} pull request ${pr.number} on GitHub`}>
            <Icon name="ExternalLink" className="size-4" />GitHub
          </Button>
        </div>
      </div>
      {pr.threadId === null && pr.projectId === null ? (
        <p className="mt-2 text-xs text-muted-foreground">Add this repository as a BB project to create a worktree and thread.</p>
      ) : pr.threadId !== null ? (
        <p className="mt-2 text-xs text-muted-foreground">Thread: {pr.threadTitle ?? pr.threadId}</p>
      ) : null}
      {error === null ? null : <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </article>
  );
}
function PrManagerPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [repositoryFilter, setRepositoryFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<PullRequest["status"] | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const applyResult = useCallback((result: { prs: PullRequest[]; refreshedAt: string | null; repositoryFilter: string | null }) => {
    setPrs(result.prs); setRefreshedAt(result.refreshedAt); setRepositoryFilter(result.repositoryFilter); setError(null);
  }, []);
  const loadCached = useCallback(async () => {
    try {
      const result = await rpc.call("prs_list");
      applyResult(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [applyResult, rpc]);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await rpc.call("prs_refresh");
      applyResult(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRefreshing(false); }
  }, [applyResult, rpc]);
  const changeRepository = useCallback(async (repository: string | null) => {
    setRepositoryFilter(repository);
    try {
      await rpc.call("prs_set_repository_filter", { repository });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      void loadCached();
    }
  }, [loadCached, rpc]);
  useEffect(() => {
    void loadCached();
  }, [loadCached]);
  useRealtime("prs-changed", loadCached);
  const repositories = useMemo(() => {
    const latestPrByRepository = new Map<string, number>();
    for (const pr of prs ?? []) {
      const createdAt = Date.parse(pr.createdAt);
      latestPrByRepository.set(pr.repository, Math.max(latestPrByRepository.get(pr.repository) ?? 0, Number.isNaN(createdAt) ? 0 : createdAt));
    }
    return [...latestPrByRepository.keys()].sort((a, b) =>
      (latestPrByRepository.get(b) ?? 0) - (latestPrByRepository.get(a) ?? 0) || a.localeCompare(b));
  }, [prs]);
  useEffect(() => {
    if (repositoryFilter !== null && !repositories.includes(repositoryFilter)) {
      void changeRepository(null);
    }
  }, [changeRepository, repositories, repositoryFilter]);
  const repositoryPrs = useMemo(
    () => repositoryFilter === null ? (prs ?? []) : (prs ?? []).filter((pr) => pr.repository === repositoryFilter),
    [prs, repositoryFilter],
  );
  const counts = useMemo(() => {
    const result = new Map<PullRequest["status"], number>();
    for (const pr of repositoryPrs) result.set(pr.status, (result.get(pr.status) ?? 0) + 1);
    return result;
  }, [repositoryPrs]);
  useEffect(() => {
    if (statusFilter !== null && !counts.has(statusFilter)) setStatusFilter(null);
  }, [counts, statusFilter]);
  const filteredPrs = useMemo(
    () => statusFilter === null ? repositoryPrs : repositoryPrs.filter((pr) => pr.status === statusFilter),
    [repositoryPrs, statusFilter],
  );
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold">Your pull requests</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {prs === null
                ? "Loading saved status…"
                : statusFilter !== null
                  ? `${filteredPrs.length} ${statusFilter.toLowerCase()} of ${repositoryPrs.length} shown`
                  : repositoryFilter === null
                    ? `${prs.length} current and recently merged`
                    : `${repositoryPrs.length} of ${prs.length} current and recently merged`}
              {refreshedAt === null ? "" : ` · refreshed ${new Date(refreshedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {repositories.length > 1 ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Repository</span>
                <select
                  value={repositoryFilter ?? ""}
                  onChange={(event) => void changeRepository(event.target.value === "" ? null : event.target.value)}
                  className="h-8 max-w-64 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">All repositories</option>
                  {repositories.map((repository) => <option key={repository} value={repository}>{repository}</option>)}
                </select>
              </label>
            ) : null}
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={refreshing}>
              <Icon name="RotateCcw" className={cn("size-4", refreshing && "animate-spin")} />Refresh
            </Button>
          </div>
        </div>
        {prs !== null && prs.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">{[...counts.entries()].map(([status, count]) =>
            <button
              key={status}
              type="button"
              aria-pressed={statusFilter === status}
              aria-label={`${statusFilter === status ? "Clear" : "Filter by"} ${status.toLowerCase()} status, ${count} pull requests`}
              onClick={() => setStatusFilter((current) => current === status ? null : status)}
              className={cn(
                "inline-flex items-center rounded-full text-xs text-muted-foreground outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                statusFilter !== null && statusFilter !== status && "opacity-50",
                statusFilter === status && "ring-2 ring-ring ring-offset-2 ring-offset-background",
              )}
            >
              <StatusBadge status={status} count={count} />
            </button>)}</div>
        ) : null}
        {error === null ? null : <div role="alert" className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>}
        <div className="mt-4 space-y-2.5">
          {prs === null ? <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">Loading your saved pull request list…</div>
          : refreshedAt === null ? <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">No saved pull request list yet. Click Refresh to load it.</div>
          : prs.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">No open or recently merged pull requests.</div>
          : filteredPrs.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">No pull requests match these filters.</div>
          : filteredPrs.map((pr) => <PullRequestRow key={pr.key} pr={pr} onChanged={() => void loadCached()} />)}
        </div>
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({ id: "pull-requests", title: "Pull requests", icon: "GitPullRequest", path: "pull-requests", component: PrManagerPage });
});
