// bb-plugin-code-review — frontend.
//
// One nav panel with two views:
//   - the PR list, filtered by who was asked to review;
//   - a PR view with its diff, the review controls, and the findings, each of
//     which you can edit, post to GitHub, or open a discussion thread about.
//
// The discussion thread renders in a fixed panel tab so talking an issue over
// with an agent does not navigate you away from the findings.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_Diff as Diff,
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
  Markdown,
  ThreadChat,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { FindingDto, PullRequestDto, ReviewDto, rpcContract } from "./server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const PANEL_ID = "code-review";
const PANEL_PATH = "code-review";
const ANY_TEAM = "__any__";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

// ---------------------------------------------------------------------------
// Routing — the nav panel owns /plugins/code-review/code-review/*
// ---------------------------------------------------------------------------

type Route =
  | { kind: "list" }
  | { kind: "pr"; repo: string; number: number };

function parseSubPath(subPath: string): Route {
  const segments = subPath.split("/").filter((segment) => segment !== "");
  if (segments[0] === "pr" && segments.length === 4) {
    const number = Number(segments[3]);
    if (Number.isInteger(number) && number > 0) {
      return { kind: "pr", repo: `${segments[1]}/${segments[2]}`, number };
    }
  }
  return { kind: "list" };
}

function routeToSubPath(route: Route): string {
  return route.kind === "pr" ? `pr/${route.repo}/${route.number}` : "";
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function reportError(cause: unknown): void {
  toast.error(cause instanceof Error ? cause.message : String(cause));
}

const SEVERITY_STYLES: Record<string, string> = {
  blocker: "border-destructive/50 text-destructive",
  high: "border-destructive/40 text-destructive",
  medium: "border-border text-foreground",
  low: "border-border text-muted-foreground",
  nit: "border-border text-muted-foreground",
};

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 font-medium", SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.medium)}
    >
      {severity}
    </Badge>
  );
}

function EmptyState({
  icon,
  title,
  detail,
}: {
  icon: IconName;
  title: string;
  detail?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <Icon name={icon} className="size-5 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      {detail === undefined ? null : (
        <div className="max-w-md text-xs text-muted-foreground">{detail}</div>
      )}
    </div>
  );
}

function locationLabel(finding: FindingDto): string {
  if (finding.startLine === null) return finding.file;
  if (finding.endLine !== null && finding.endLine !== finding.startLine) {
    return `${finding.file}:${finding.startLine}-${finding.endLine}`;
  }
  return `${finding.file}:${finding.startLine}`;
}

/** Refetches on mount and on every server "code-review-changed" signal. */
function useLiveQuery<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // A slow gh call must not overwrite a newer result that already landed.
  const generation = useRef(0);

  const refetch = useCallback(() => {
    const mine = ++generation.current;
    setIsLoading(true);
    load().then(
      (result) => {
        if (mine !== generation.current) return;
        setData(result);
        setError(null);
        setIsLoading(false);
      },
      (cause: unknown) => {
        if (mine !== generation.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setIsLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(refetch, [refetch]);
  useRealtime("code-review-changed", refetch);
  return { data, error, isLoading, refetch };
}

// ---------------------------------------------------------------------------
// The discussion tab
// ---------------------------------------------------------------------------

interface DiscussionTarget extends Record<string, JsonValue> {
  threadId: string;
  title: string;
}

const discussionTabRef = {
  panelId: PANEL_ID,
  id: "discussion",
  experimental_target: {
    validate(value: JsonValue): value is DiscussionTarget {
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).threadId === "string" &&
        typeof (value as Record<string, unknown>).title === "string"
      );
    },
  },
} as const;

function DiscussionTab() {
  const state = experimental_useFixedTabTarget(discussionTabRef);
  if (state === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon="SideChat"
          title="No discussion open"
          detail={'Press "Discuss" on a finding to talk it over with an agent here.'}
        />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ThreadChat
        key={state.target.threadId}
        threadId={state.target.threadId}
        variant="compact"
        layout="contained"
        className="min-h-0 flex-1"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The PR list
// ---------------------------------------------------------------------------

type FilterTab = "mine" | "teams" | "all";

function reviewBadge(pr: PullRequestDto): ReactNode {
  switch (pr.reviewStatus) {
    case "running":
    case "queued":
      return (
        <Badge variant="outline" className="gap-1 border-border text-muted-foreground">
          <Icon name="Spinner" className="size-3 animate-spin" />
          reviewing
        </Badge>
      );
    case "reported":
      return (
        <Badge variant="outline" className="border-border">
          {pr.openFindings} open
          {pr.postedFindings > 0 ? ` · ${pr.postedFindings} posted` : ""}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="border-destructive/40 text-destructive">
          review failed
        </Badge>
      );
    default:
      return null;
  }
}

function PrRow({ pr, onOpen }: { pr: PullRequestDto; onOpen: () => void }) {
  const requestedTeams = pr.reviewRequests
    .map((request) => request.teamSlug)
    .filter((slug): slug is string => slug !== null)
    .map((slug) => slug.split("/").pop() ?? slug);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
    >
      <div className="flex items-start gap-2">
        <Icon
          name={pr.isDraft ? "GitPullRequestDraft" : "GitPullRequest"}
          className={cn("mt-0.5 size-4 shrink-0", pr.isDraft ? "text-muted-foreground" : "text-foreground")}
        />
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{pr.title}</span>
        {reviewBadge(pr)}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-muted-foreground">
        <span>#{pr.number}</span>
        <span>·</span>
        <span>{pr.author}</span>
        <span>·</span>
        <span className="text-foreground/70">+{pr.additions}</span>
        <span className="text-foreground/70">−{pr.deletions}</span>
        <span>in {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}</span>
        {requestedTeams.length > 0 ? (
          <>
            <span>·</span>
            <span>team: {requestedTeams.join(", ")}</span>
          </>
        ) : null}
      </div>
    </button>
  );
}

function PrListView({
  rpc,
  repo,
  repos,
  onRepoChange,
  myTeams,
  onOpenPr,
}: {
  rpc: Rpc;
  repo: string | null;
  repos: string[];
  onRepoChange: (repo: string) => void;
  myTeams: string[];
  onOpenPr: (repo: string, number: number) => void;
}) {
  const [tab, setTab] = useState<FilterTab>("mine");
  const [team, setTeam] = useState<string>(ANY_TEAM);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const filter = useMemo(() => {
    if (tab === "all") return { kind: "all" as const };
    if (tab === "mine") return { kind: "mine" as const };
    return team === ANY_TEAM
      ? { kind: "my-teams" as const }
      : { kind: "team" as const, teamSlug: team };
  }, [tab, team]);

  const filterKey = JSON.stringify(filter);
  const { data, error, isLoading, refetch } = useLiveQuery(
    async () =>
      repo === null
        ? { pullRequests: [] as PullRequestDto[] }
        : rpc.call("listPullRequests", { repo, filter }),
    [rpc, repo, filterKey],
  );

  const refresh = useCallback(() => {
    if (repo === null) return;
    setIsRefreshing(true);
    rpc
      .call("listPullRequests", { repo, filter, refresh: true })
      .then(() => refetch(), reportError)
      .finally(() => setIsRefreshing(false));
  }, [repo, rpc, filter, refetch]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={repo ?? ""} onValueChange={onRepoChange}>
          <SelectTrigger className="h-8 w-[16rem] text-xs">
            <SelectValue placeholder="Pick a repository" />
          </SelectTrigger>
          <SelectContent>
            {repos.map((name) => (
              <SelectItem key={name} value={name} className="text-xs">
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tabs value={tab} onValueChange={(next) => setTab(next as FilterTab)}>
          <TabsList className="h-8">
            <TabsTrigger value="mine" className="text-xs">
              Asked me
            </TabsTrigger>
            <TabsTrigger value="teams" className="text-xs">
              Asked my team
            </TabsTrigger>
            <TabsTrigger value="all" className="text-xs">
              All open
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {tab === "teams" ? (
          <Select value={team} onValueChange={setTeam}>
            <SelectTrigger className="h-8 w-[15rem] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_TEAM} className="text-xs">
                Any of my teams
              </SelectItem>
              {myTeams.map((slug) => (
                <SelectItem key={slug} value={slug} className="text-xs">
                  {slug}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={refresh}
          disabled={repo === null || isRefreshing}
        >
          <Icon
            name="ArrowReloadHorizontal"
            className={cn("size-3.5", isRefreshing && "animate-spin")}
          />
          Refresh
        </Button>
      </div>

      {tab === "teams" && myTeams.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No teams found. `gh api /user/teams` needs the `read:org` scope — run{" "}
          <code className="font-mono">gh auth refresh -s read:org</code>, or list your teams
          in the plugin&apos;s Teams setting.
        </p>
      ) : null}

      {repo === null ? (
        <EmptyState
          icon="FolderGit"
          title="No repositories"
          detail="Add owner/repo lines to the plugin's Repositories setting, or open a BB project whose checkout has a GitHub origin remote."
        />
      ) : error !== null ? (
        <EmptyState icon="AlertTriangle" title="Could not list pull requests" detail={error} />
      ) : isLoading && data === null ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : data === null || data.pullRequests.length === 0 ? (
        <EmptyState
          icon="GitPullRequest"
          title="Nothing to review"
          detail={
            tab === "mine"
              ? "No open pull request in this repo has a review request for you."
              : tab === "teams"
                ? "No open pull request in this repo has a review request for these teams."
                : "This repo has no open pull requests."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {data.pullRequests.map((pr) => (
            <PrRow
              key={pr.number}
              pr={pr}
              onOpen={() => onOpenPr(pr.repo, pr.number)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A finding
// ---------------------------------------------------------------------------

function FindingCard({
  rpc,
  finding,
  onDiscuss,
}: {
  rpc: Rpc;
  finding: FindingDto;
  onDiscuss: (finding: FindingDto) => void;
}) {
  const stored = finding.draftComment ?? finding.suggestedComment;
  const [comment, setComment] = useState(stored);
  const [isBusy, setIsBusy] = useState(false);
  const [inlineFailed, setInlineFailed] = useState(false);
  // Adopt server-side changes (a re-run, another window) without clobbering
  // an edit in progress: the stored value is the identity of the draft.
  const lastStored = useRef(stored);
  useEffect(() => {
    if (lastStored.current !== stored) {
      lastStored.current = stored;
      setComment(stored);
    }
  }, [stored]);

  const isDirty = comment !== stored;
  const isPosted = finding.state === "posted";

  const save = useCallback(() => {
    return rpc
      .call("setFindingComment", { findingId: finding.id, comment })
      .then(() => undefined, reportError);
  }, [rpc, finding.id, comment]);

  const post = useCallback(
    async (mode: "inline" | "issue") => {
      setIsBusy(true);
      try {
        if (isDirty) await save();
        await rpc.call("postFinding", { findingId: finding.id, mode });
        toast.success("Comment posted");
        setInlineFailed(false);
      } catch (cause) {
        reportError(cause);
        if (mode === "inline") setInlineFailed(true);
      } finally {
        setIsBusy(false);
      }
    },
    [rpc, finding.id, isDirty, save],
  );

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-border bg-card p-3",
        finding.state === "dismissed" && "opacity-55",
      )}
    >
      <div className="flex items-start gap-2">
        <SeverityBadge severity={finding.severity} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">{finding.title}</p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {locationLabel(finding)}
            {finding.category === "" ? "" : ` · ${finding.category}`}
          </p>
        </div>
        {isPosted ? (
          <Badge variant="outline" className="shrink-0 gap-1 border-border">
            <Icon name="Check" className="size-3" />
            posted
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 text-sm">
        {finding.background === "" ? null : (
          <Field label="Background" value={finding.background} />
        )}
        <Field label="Problem" value={finding.problem} />
        {finding.suggestedFix === "" ? null : (
          <Field label="Suggested fix" value={finding.suggestedFix} />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Comment to post
          </p>
          {isDirty && !isPosted ? (
            <span className="text-xs text-muted-foreground">unsaved edit</span>
          ) : finding.draftComment !== null ? (
            <span className="text-xs text-muted-foreground">edited</span>
          ) : null}
        </div>
        {isPosted ? (
          <div className="rounded-md border border-border bg-muted/30 p-2 text-sm whitespace-pre-wrap">
            {comment}
          </div>
        ) : (
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            onBlur={() => {
              if (isDirty) void save();
            }}
            rows={Math.min(12, Math.max(3, comment.split("\n").length + 1))}
            className="text-sm"
            aria-label={`Comment for ${finding.title}`}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {isPosted ? (
          finding.commentUrl === null ? null : (
            <UrlLink
              href={finding.commentUrl}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              <Icon name="ExternalLink" className="size-3.5" />
              View on GitHub
            </UrlLink>
          )
        ) : (
          <>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={isBusy || comment.trim() === ""}
              onClick={() => void post("inline")}
            >
              <Icon name="Sent" className="size-3.5" />
              Post comment
            </Button>
            {inlineFailed || finding.startLine === null ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                disabled={isBusy || comment.trim() === ""}
                onClick={() => void post("issue")}
              >
                Post as a general PR comment
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 text-xs"
              disabled={isBusy}
              onClick={() => onDiscuss(finding)}
            >
              <Icon name="SideChat" className="size-3.5" />
              Discuss
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs text-muted-foreground"
              disabled={isBusy}
              onClick={() => {
                rpc
                  .call("setFindingState", {
                    findingId: finding.id,
                    state: finding.state === "dismissed" ? "open" : "dismissed",
                  })
                  .then(() => undefined, reportError);
              }}
            >
              {finding.state === "dismissed" ? "Restore" : "Dismiss"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-sm">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The PR view
// ---------------------------------------------------------------------------

function ReviewControls({
  rpc,
  repo,
  number,
  review,
  skills,
}: {
  rpc: Rpc;
  repo: string;
  number: number;
  review: ReviewDto | null;
  skills: string[];
}) {
  const navigate = useBbNavigate();
  const [isStarting, setIsStarting] = useState(false);
  const isRunning = review !== null && (review.status === "running" || review.status === "queued");

  const start = useCallback(() => {
    setIsStarting(true);
    rpc
      .call("startReview", { repo, number })
      .then(() => toast.success("Review started"), reportError)
      .finally(() => setIsStarting(false));
  }, [rpc, repo, number]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={isStarting || isRunning}
          onClick={start}
        >
          <Icon
            name={isRunning ? "Spinner" : "Bot"}
            className={cn("size-3.5", isRunning && "animate-spin")}
          />
          {isRunning ? "Reviewing…" : review === null ? "Review this PR" : "Re-run review"}
        </Button>
        {review?.threadId != null ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1.5 text-xs"
            onClick={() => navigate.toThread(review.threadId as string)}
          >
            <Icon name="MessageSquare" className="size-3.5" />
            Open review thread
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {skills.length === 0
            ? "Generic review — set review skills in plugin settings"
            : `Skills: ${skills.join(", ")}`}
        </span>
      </div>
      {review?.error != null ? (
        <p className="text-xs text-destructive">{review.error}</p>
      ) : null}
      {review !== null && review.summary !== "" ? (
        <div className="border-t border-border pt-2 text-sm">
          <Markdown content={review.summary} />
        </div>
      ) : null}
    </div>
  );
}

function PrDetailView({
  rpc,
  repo,
  number,
  skills,
  onBack,
}: {
  rpc: Rpc;
  repo: string;
  number: number;
  skills: string[];
  onBack: () => void;
}) {
  const panel = experimental_useAppPanel();
  const [showDiff, setShowDiff] = useState(false);
  const { data, error, isLoading } = useLiveQuery(
    () => rpc.call("getPullRequest", { repo, number }),
    [rpc, repo, number],
  );

  const discuss = useCallback(
    (finding: FindingDto) => {
      rpc.call("discussFinding", { findingId: finding.id }).then((result) => {
        const opened = panel.openFixedTab({
          surface: { kind: "current" },
          tab: discussionTabRef,
          target: { threadId: result.threadId, title: finding.title },
        });
        if (!opened) toast.error("Could not open the discussion tab.");
      }, reportError);
    },
    [rpc, panel],
  );

  const grouped = useMemo(() => {
    const findings = data?.findings ?? [];
    return {
      open: findings.filter((finding) => finding.state === "open"),
      posted: findings.filter((finding) => finding.state === "posted"),
      dismissed: findings.filter((finding) => finding.state === "dismissed"),
    };
  }, [data]);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} />
        <EmptyState icon="AlertTriangle" title="Could not load this pull request" detail={error} />
      </div>
    );
  }
  if (isLoading && data === null) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} />
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }
  const pr = data?.pullRequest ?? null;

  return (
    <div className="flex flex-col gap-4">
      <BackButton onBack={onBack} />

      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <Icon name="GitPullRequest" className="mt-1 size-4 shrink-0" />
          <h2 className="text-base font-semibold leading-snug">
            {pr?.title ?? `Pull request #${number}`}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-muted-foreground">
          <span>
            {repo}#{number}
          </span>
          {pr === null ? null : (
            <>
              <span>·</span>
              <span>{pr.author}</span>
              <span>·</span>
              <span>
                {pr.headRefName} → {pr.baseRefName}
              </span>
              <span>·</span>
              <UrlLink
                href={pr.url}
                className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
              >
                <Icon name="ExternalLink" className="size-3" />
                GitHub
              </UrlLink>
            </>
          )}
        </div>
      </div>

      <ReviewControls
        rpc={rpc}
        repo={repo}
        number={number}
        review={data?.review ?? null}
        skills={data?.review?.skills ?? skills}
      />

      <Section title={`Findings${grouped.open.length > 0 ? ` (${grouped.open.length})` : ""}`}>
        {grouped.open.length === 0 ? (
          <EmptyState
            icon="Bug"
            title={
              data?.review == null
                ? "No review yet"
                : data.review.status === "reported"
                  ? "No open findings"
                  : "Review in progress"
            }
            detail={
              data?.review == null
                ? 'Press "Review this PR" to run your review skills against this change.'
                : data.review.status === "reported"
                  ? "The review finished without raising anything still open."
                  : "The review thread is working. Findings appear here as soon as it submits them."
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {grouped.open.map((finding) => (
              <FindingCard key={finding.id} rpc={rpc} finding={finding} onDiscuss={discuss} />
            ))}
          </div>
        )}
      </Section>

      {grouped.posted.length > 0 ? (
        <Section title={`Posted (${grouped.posted.length})`}>
          <div className="flex flex-col gap-3">
            {grouped.posted.map((finding) => (
              <FindingCard key={finding.id} rpc={rpc} finding={finding} onDiscuss={discuss} />
            ))}
          </div>
        </Section>
      ) : null}

      {grouped.dismissed.length > 0 ? (
        <Section title={`Dismissed (${grouped.dismissed.length})`}>
          <div className="flex flex-col gap-3">
            {grouped.dismissed.map((finding) => (
              <FindingCard key={finding.id} rpc={rpc} finding={finding} onDiscuss={discuss} />
            ))}
          </div>
        </Section>
      ) : null}

      {data !== null && data.body !== "" ? (
        <Section title="Description">
          <div className="rounded-lg border border-border bg-card p-3">
            <Markdown content={data.body} />
          </div>
        </Section>
      ) : null}

      <Section
        title={`Diff${data === null ? "" : ` (${data.files.length} file${data.files.length === 1 ? "" : "s"})`}`}
        action={
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setShowDiff((current) => !current)}
          >
            {showDiff ? "Hide" : "Show"}
          </Button>
        }
      >
        {data?.diffError != null ? (
          <p className="text-xs text-destructive">{data.diffError}</p>
        ) : !showDiff ? null : (
          <div className="flex flex-col gap-3">
            {(data?.files ?? []).map((file) => (
              <div key={file.path} className="overflow-hidden rounded-lg border border-border">
                <p className="border-b border-border bg-muted/30 px-3 py-1.5 font-mono text-xs">
                  {file.path}
                </p>
                <Diff patch={file.patch} path={file.path} />
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <Button variant="ghost" size="sm" className="h-7 w-fit gap-1 px-1.5 text-xs" onClick={onBack}>
      <Icon name="ChevronLeft" className="size-3.5" />
      All pull requests
    </Button>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

function CodeReviewPanel({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const route = useMemo(() => parseSubPath(subPath), [subPath]);
  const [repo, setRepo] = useState<string | null>(null);

  const status = useLiveQuery(() => rpc.call("status"), [rpc]);
  const repos = status.data?.repos ?? [];

  // Default to the first known repo, and follow whichever repo the open PR
  // belongs to so going back lands on the right list.
  useEffect(() => {
    if (route.kind === "pr") {
      setRepo(route.repo);
      return;
    }
    setRepo((current) =>
      current !== null && repos.includes(current) ? current : (repos[0] ?? null),
    );
  }, [route, repos]);

  const go = useCallback(
    (next: Route) => navigate.toPluginPanel(PANEL_PATH, { subPath: routeToSubPath(next) }),
    [navigate],
  );

  const ghState = status.data?.state ?? "checking";
  const blocked = ghState === "needs_configuration" || ghState === "unavailable";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl p-4 md:p-5">
        {blocked ? (
          <EmptyState
            icon={ghState === "needs_configuration" ? "Settings" : "AlertTriangle"}
            title={
              ghState === "needs_configuration"
                ? "The GitHub CLI needs setting up"
                : "GitHub is not reachable"
            }
            detail={
              <>
                <p>{status.data?.detail ?? "gh could not be reached."}</p>
                <p className="mt-2">
                  Install the GitHub CLI and run <code className="font-mono">gh auth login</code>,
                  then reload the plugin.
                </p>
              </>
            }
          />
        ) : route.kind === "pr" ? (
          <PrDetailView
            rpc={rpc}
            repo={route.repo}
            number={route.number}
            skills={status.data?.skills ?? []}
            onBack={() => go({ kind: "list" })}
          />
        ) : (
          <PrListView
            rpc={rpc}
            repo={repo}
            repos={repos}
            onRepoChange={setRepo}
            myTeams={status.data?.myTeams ?? []}
            onOpenPr={(nextRepo, number) => go({ kind: "pr", repo: nextRepo, number })}
          />
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL_ID,
    title: "Code Review",
    icon: "GitPullRequest",
    path: PANEL_PATH,
    component: CodeReviewPanel,
    fixedTabs: [
      {
        ...discussionTabRef,
        title: "Discussion",
        icon: "SideChat",
        layout: "flush",
        component: DiscussionTab,
      },
    ],
  });
});
