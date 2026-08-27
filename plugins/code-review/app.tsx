// bb-plugin-code-review — frontend.
//
// Three views, one nav panel:
//   - the PR list, filtered by who was asked to review;
//   - a PR's issue list: one compact row per finding, plus a way into GitHub;
//   - an issue, with its detail on top and the code it points at below.
//
// The panel remembers the repo and filter server-side, so re-opening the tab
// resumes where it left off instead of asking again.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
  ThreadChat,
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
/** Context ladder for the snippet "more context" control. */
const CONTEXT_STEPS = [3, 25, 100] as const;

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type PrFilter =
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "my-teams" }
  | { kind: "team"; teamSlug: string };

/** One place a finding points at, with its code. Mirrors the RPC output. */
interface LocationDto {
  file: string;
  startLine: number | null;
  endLine: number | null;
  note: string;
  isPrimary: boolean;
  diffUrl: string;
  blobUrl: string;
  /** Markdown quoting this location, for a comment that cannot be anchored. */
  contextBlock: string;
  firstLine: number;
  lines: string[];
  hasMoreAbove: boolean;
  hasMoreBelow: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Routing — the nav panel owns /plugins/code-review/code-review/*
// ---------------------------------------------------------------------------

type Route =
  | { kind: "list" }
  | { kind: "pr"; repo: string; number: number }
  | { kind: "finding"; repo: string; number: number; findingId: string };

function parseSubPath(subPath: string): Route {
  const segments = subPath.split("/").filter((segment) => segment !== "");
  if (segments[0] === "pr" && segments.length >= 4) {
    const number = Number(segments[3]);
    const repo = `${segments[1]}/${segments[2]}`;
    if (Number.isInteger(number) && number > 0) {
      if (segments[4] === "f" && segments[5] !== undefined) {
        return { kind: "finding", repo, number, findingId: segments[5] };
      }
      return { kind: "pr", repo, number };
    }
  }
  return { kind: "list" };
}

function routeToSubPath(route: Route): string {
  switch (route.kind) {
    case "list":
      return "";
    case "pr":
      return `pr/${route.repo}/${route.number}`;
    case "finding":
      return `pr/${route.repo}/${route.number}/f/${route.findingId}`;
  }
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

/**
 * A link out to GitHub. Opens through BB's own URL routing — the in-app
 * browser when this client prefers it — but stays a real anchor so copy-link
 * and modifier-clicks still behave, which matters when you want to paste a
 * file link into a review.
 */
function GithubLink({
  href,
  className,
  title,
  children,
}: {
  href: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const navigate = useBbNavigate();
  return (
    <a
      href={href}
      className={className}
      title={title}
      onClick={(event) => {
        // Leave "open in a new tab" and friends to the browser.
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        // A false return means this client will not handle the URL, so fall
        // through to the anchor rather than swallowing the click.
        if (navigate.openUrl(href)) event.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

/** "just now" / "12m ago" / "3h ago" / "2d ago". */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function locationLabel(target: {
  file: string;
  startLine: number | null;
  endLine: number | null;
}): string {
  if (target.startLine === null) return target.file;
  const range =
    target.endLine !== null && target.endLine !== target.startLine
      ? `${target.startLine}-${target.endLine}`
      : `${target.startLine}`;
  return `${target.file}:${range}`;
}

/**
 * Where posting this finding actually puts the comment. GitHub anchors a
 * multi-line comment at the end of the range, and a finding with no line
 * anchor can only become a general PR comment — so say which it will be
 * rather than leaving the reviewer to find out after pressing the button.
 */
function postTargetLabel(finding: FindingDto): { text: string; note: string | null } {
  if (finding.startLine === null) {
    return {
      text: "as a general comment on the pull request",
      note: "This issue has no line anchor, so it cannot be an inline comment.",
    };
  }
  const anchor = finding.postAnchor;
  if (anchor === null) {
    return {
      text: "as a general comment on the pull request",
      note:
        `GitHub only accepts inline comments on lines that are part of the diff, and ` +
        `${locationLabel(finding)} is not.`,
    };
  }
  const range =
    anchor.startLine !== null ? `lines ${anchor.startLine}–${anchor.line}` : `line ${anchor.line}`;
  const side = finding.side === "LEFT" ? " of the old file" : "";
  return {
    text: `on ${finding.file}, ${range}${side}`,
    note: anchor.adjusted
      ? `Narrowed from ${locationLabel(finding)}: the rest of that range is not in the diff, ` +
        "and GitHub only anchors comments inside it."
      : null,
  };
}

/**
 * Grow a textarea to fit its content. A suggested comment is usually one long
 * wrapped paragraph, so counting newlines under-sizes it and clips the text
 * the reviewer is about to publish.
 */
function useAutoSizedTextarea(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [value]);
  return ref;
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
          detail={'Press "Discuss" on an issue to talk it over with an agent here.'}
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

function tabAndTeamFor(filter: PrFilter): { tab: FilterTab; team: string } {
  switch (filter.kind) {
    case "all":
      return { tab: "all", team: ANY_TEAM };
    case "mine":
      return { tab: "mine", team: ANY_TEAM };
    case "my-teams":
      return { tab: "teams", team: ANY_TEAM };
    case "team":
      return { tab: "teams", team: filter.teamSlug };
  }
}

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
          className={cn(
            "mt-0.5 size-4 shrink-0",
            pr.isDraft ? "text-muted-foreground" : "text-foreground",
          )}
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
        <span>
          in {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
        </span>
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
  filter,
  onRepoChange,
  onFilterChange,
  myTeams,
  onOpenPr,
}: {
  rpc: Rpc;
  repo: string | null;
  repos: string[];
  filter: PrFilter;
  onRepoChange: (repo: string) => void;
  onFilterChange: (filter: PrFilter) => void;
  myTeams: string[];
  onOpenPr: (repo: string, number: number) => void;
}) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { tab, team } = tabAndTeamFor(filter);

  const filterKey = JSON.stringify(filter);
  const { data, error, isLoading, refetch } = useLiveQuery(
    async () =>
      repo === null
        ? { fetchedAt: "", pullRequests: [] as PullRequestDto[] }
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
        <Tabs
          value={tab}
          onValueChange={(next) => {
            if (next === "all") onFilterChange({ kind: "all" });
            else if (next === "mine") onFilterChange({ kind: "mine" });
            else {
              onFilterChange(
                team === ANY_TEAM ? { kind: "my-teams" } : { kind: "team", teamSlug: team },
              );
            }
          }}
        >
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
          <Select
            value={team}
            onValueChange={(next) =>
              onFilterChange(
                next === ANY_TEAM ? { kind: "my-teams" } : { kind: "team", teamSlug: next },
              )
            }
          >
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
        {/* The list never refreshes on its own now, so say how old it is. */}
        {data?.fetchedAt ? (
          <span className="text-xs text-muted-foreground">
            updated {relativeTime(data.fetchedAt)}
          </span>
        ) : null}
      </div>

      {tab === "teams" && myTeams.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No teams found. `gh api /user/teams` needs the `read:org` scope — run{" "}
          <code className="font-mono">gh auth refresh -s read:org</code>, or list your teams in
          the plugin&apos;s Teams setting.
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
            <PrRow key={pr.number} pr={pr} onOpen={() => onOpenPr(pr.repo, pr.number)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A PR's issue list
// ---------------------------------------------------------------------------

function FindingRow({ finding, onOpen }: { finding: FindingDto; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/50",
        finding.state === "dismissed" && "opacity-55",
      )}
    >
      <div className="flex items-start gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="min-w-0 flex-1 text-sm font-medium leading-snug">{finding.title}</span>
        {finding.state === "posted" ? (
          <Badge variant="outline" className="shrink-0 gap-1 border-border">
            <Icon name="Check" className="size-3" />
            {finding.postedAs === "pending-review" ? "drafted" : "posted"}
          </Badge>
        ) : null}
        <Icon name="ChevronRight" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </div>
      {/* The gist, clamped to three lines — the point of this row. */}
      <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground">{finding.gist}</p>
      <p className="font-mono text-[11px] text-muted-foreground/80">{locationLabel(finding)}</p>
    </button>
  );
}

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

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={isStarting || isRunning}
          onClick={() => {
            setIsStarting(true);
            rpc
              .call("startReview", { repo, number })
              .then(() => toast.success("Review started"), reportError)
              .finally(() => setIsStarting(false));
          }}
        >
          <Icon
            name={isRunning ? "Spinner" : "Bot"}
            className={cn("size-3.5", isRunning && "animate-spin")}
          />
          {isRunning ? "Reviewing…" : review === null ? "Review this PR" : "Re-run review"}
        </Button>
        {review?.threadId != null ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 text-xs"
            onClick={() => navigate.toThread(review.threadId as string)}
          >
            <Icon name="MessageSquare" className="size-3.5" />
            Review thread
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {skills.length === 0 ? "Generic review" : `Skills: ${skills.join(", ")}`}
        </span>
      </div>
      {review?.error != null ? <p className="text-xs text-destructive">{review.error}</p> : null}
    </div>
  );
}

function PrFindingsView({
  rpc,
  repo,
  number,
  skills,
  onBack,
  onOpenFinding,
}: {
  rpc: Rpc;
  repo: string;
  number: number;
  skills: string[];
  onBack: () => void;
  onOpenFinding: (findingId: string) => void;
}) {
  const { data, error, isLoading } = useLiveQuery(
    () => rpc.call("getPullRequest", { repo, number }),
    [rpc, repo, number],
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
        <BackButton onBack={onBack} label="All pull requests" />
        <EmptyState icon="AlertTriangle" title="Could not load this pull request" detail={error} />
      </div>
    );
  }
  if (isLoading && data === null) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} label="All pull requests" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }
  const pr = data?.pullRequest ?? null;
  const isEmpty =
    grouped.open.length === 0 && grouped.posted.length === 0 && grouped.dismissed.length === 0;

  const section = (title: string, findings: FindingDto[]) =>
    findings.length === 0 ? null : (
      <Section key={title} title={`${title} (${findings.length})`}>
        <div className="flex flex-col gap-2">
          {findings.map((finding) => (
            <FindingRow
              key={finding.id}
              finding={finding}
              onOpen={() => onOpenFinding(finding.id)}
            />
          ))}
        </div>
      </Section>
    );

  return (
    <div className="flex flex-col gap-4">
      <BackButton onBack={onBack} label="All pull requests" />

      <div className="flex flex-col gap-1">
        <div className="flex items-start gap-2">
          <Icon name="GitPullRequest" className="mt-1 size-4 shrink-0" />
          <h2 className="min-w-0 flex-1 text-base font-semibold leading-snug">
            {pr?.title ?? `Pull request #${number}`}
          </h2>
          {pr === null ? null : (
            <GithubLink
              href={pr.url}
              className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent"
            >
              <Icon name="Github" className="size-3.5" />
              Open on GitHub
            </GithubLink>
          )}
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
              <span className="text-foreground/70">+{pr.additions}</span>
              <span className="text-foreground/70">−{pr.deletions}</span>
              <span>
                in {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
              </span>
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

      {isEmpty ? (
        <EmptyState
          icon="Bug"
          title={
            data?.review == null
              ? "No review yet"
              : data.review.status === "reported"
                ? "No issues found"
                : "Review in progress"
          }
          detail={
            data?.review == null
              ? 'Press "Review this PR" to run your review skills against this change.'
              : data.review.status === "reported"
                ? "The review finished without raising anything."
                : "The review thread is working. Issues appear here as soon as it submits them."
          }
        />
      ) : (
        <>
          {section("Issues", grouped.open)}
          {section("Posted", grouped.posted)}
          {section("Dismissed", grouped.dismissed)}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One issue, with the code it points at
// ---------------------------------------------------------------------------

/**
 * A snippet with real file line numbers. BB's SourceCode component numbers an
 * excerpt from 1, which would misreport every line — and these line numbers
 * are exactly what the reviewer is checking against the finding.
 */
function CodeSnippet({ location }: { location: LocationDto }) {
  const from = location.startLine;
  const to = location.endLine ?? location.startLine;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs">
        <tbody>
          {location.lines.map((line, index) => {
            const lineNumber = location.firstLine + index;
            const isCited = from !== null && lineNumber >= from && lineNumber <= (to ?? from);
            return (
              <tr key={lineNumber} className={cn(isCited && "bg-accent/60")}>
                <td className="w-[1%] select-none whitespace-nowrap border-r border-border px-2 py-px text-right align-top text-muted-foreground/70">
                  {lineNumber}
                </td>
                <td className="whitespace-pre px-3 py-px">{line === "" ? " " : line}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LocationCard({ location }: { location: LocationDto }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
        <GithubLink
          href={location.diffUrl}
          className="min-w-0 flex-1 truncate font-mono text-xs underline-offset-4 hover:underline"
          title={`Open ${location.file} in the pull request diff on GitHub`}
        >
          {locationLabel(location)}
        </GithubLink>
        {location.isPrimary ? (
          <Badge variant="outline" className="shrink-0 border-border text-[10px]">
            this issue
          </Badge>
        ) : null}
        <GithubLink
          href={location.diffUrl}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground underline-offset-4 hover:underline"
        >
          <Icon name="Github" className="size-3.5" />
          diff
        </GithubLink>
      </div>
      {location.note === "" ? null : (
        <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {location.note}
        </p>
      )}
      {location.error !== null ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{location.error}</p>
      ) : location.lines.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No lines to show.</p>
      ) : (
        <CodeSnippet location={location} />
      )}
    </div>
  );
}

function FindingActions({
  rpc,
  finding,
  diffUrl,
  primaryLocation,
  hasPendingReview,
  onDiscuss,
}: {
  rpc: Rpc;
  finding: FindingDto;
  /** The finding's own place in the PR diff, when the code has been resolved. */
  diffUrl?: string;
  /** The finding's own code, for quoting into a general comment. */
  primaryLocation?: LocationDto;
  /** The reviewer already has an unsubmitted review open on this PR. */
  hasPendingReview: boolean;
  onDiscuss: (finding: FindingDto) => void;
}) {
  const stored = finding.draftComment ?? finding.suggestedComment;
  const [comment, setComment] = useState(stored);
  const [isBusy, setIsBusy] = useState(false);
  const [inlineFailed, setInlineFailed] = useState(false);
  // Adopt server-side changes (a re-run, another window) without clobbering an
  // edit in progress: the stored value is the identity of the draft.
  const lastStored = useRef(stored);
  useEffect(() => {
    if (lastStored.current !== stored) {
      lastStored.current = stored;
      setComment(stored);
    }
  }, [stored]);

  const isDirty = comment !== stored;
  const isPosted = finding.state === "posted";
  const commentRef = useAutoSizedTextarea(comment);
  const target = postTargetLabel(finding);
  const onlyGeneralComment = finding.postAnchor === null;
  // A general comment lands at the bottom of the conversation with no code
  // beside it, so a comment written about a line needs to carry its own
  // context. Offered rather than applied: the body is posted verbatim, and
  // that stays true only if what is in the box is all there is.
  const contextBlock =
    onlyGeneralComment && primaryLocation !== undefined && primaryLocation.contextBlock !== ""
      ? primaryLocation.contextBlock
      : null;
  const hasContext = contextBlock !== null && comment.includes(contextBlock);
  // A comment added to an unsubmitted review is a draft: nobody else can see
  // it until the review is submitted on GitHub.
  const isDraft = isPosted && finding.postedAs === "pending-review";

  const save = useCallback(
    () =>
      rpc
        .call("setFindingComment", { findingId: finding.id, comment })
        .then(() => undefined, reportError),
    [rpc, finding.id, comment],
  );

  const post = useCallback(
    async (mode: "inline" | "issue" | "review") => {
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
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {isPosted ? (isDraft ? "Draft comment" : "Posted comment") : "Comment to post"}
        </p>
        {isDirty && !isPosted ? (
          <span className="text-xs text-muted-foreground">unsaved edit</span>
        ) : finding.draftComment !== null ? (
          <span className="text-xs text-muted-foreground">edited</span>
        ) : null}
      </div>
      <p className="-mt-1 text-xs text-muted-foreground">
        {isPosted ? (isDraft ? "Drafted " : "Posted ") : "Posts "}
        {diffUrl === undefined || onlyGeneralComment ? (
          <span className="font-mono">{target.text}</span>
        ) : (
          <GithubLink href={diffUrl} className="font-mono underline-offset-4 hover:underline">
            {target.text}
          </GithubLink>
        )}
      </p>
      {target.note === null ? null : (
        <p className="-mt-1 text-xs text-muted-foreground/80">{target.note}</p>
      )}
      {!isPosted && contextBlock !== null && !hasContext ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground">
            A general comment appears at the bottom of the pull request with no code next to it.
            Add a link to the file and the lines this is about, so it reads on its own.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-fit gap-1.5 text-xs"
            onClick={() => {
              const next = `${contextBlock}\n\n${comment}`;
              setComment(next);
              rpc
                .call("setFindingComment", { findingId: finding.id, comment: next })
                .then(() => undefined, reportError);
            }}
          >
            <Icon name="Code" className="size-3.5" />
            Add the file link and quoted lines
          </Button>
        </div>
      ) : null}
      {!isPosted && hasPendingReview && !onlyGeneralComment ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          You have a review open on this pull request, so this joins it as a draft alongside the
          comments you made on GitHub. Submit that review on GitHub to publish them together.
        </p>
      ) : null}
      {isDraft ? (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          You have a review open on this pull request, so this was added to it as a draft.
          Submit that review on GitHub to publish it.
        </p>
      ) : null}
      {isPosted ? (
        <div className="whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-2 text-sm">
          {comment}
        </div>
      ) : (
        <Textarea
          ref={commentRef}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          onBlur={() => {
            if (isDirty) void save();
          }}
          rows={1}
          // Height is managed by useAutoSizedTextarea; hide the scrollbar it
          // would otherwise show while growing.
          className="resize-none overflow-hidden text-sm"
          aria-label={`Comment for ${finding.title}`}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {isPosted ? (
          finding.commentUrl === null ? null : (
            <GithubLink
              href={finding.commentUrl}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              <Icon name="ExternalLink" className="size-3.5" />
              View on GitHub
            </GithubLink>
          )
        ) : (
          <>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={isBusy || comment.trim() === ""}
              onClick={() => void post(onlyGeneralComment ? "issue" : "inline")}
            >
              <Icon name="Sent" className="size-3.5" />
              {onlyGeneralComment
                ? "Post as a general comment"
                : hasPendingReview
                  ? "Add to my review"
                  : "Post comment"}
            </Button>
            {/* Mirrors GitHub's own split: publish now, or batch into a review.
                With a review already open, GitHub allows only the batched form,
                so the single button above already does that. */}
            {!onlyGeneralComment && !hasPendingReview ? (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 text-xs"
                disabled={isBusy || comment.trim() === ""}
                onClick={() => void post("review")}
              >
                Start a review
              </Button>
            ) : null}
            {inlineFailed && !onlyGeneralComment ? (
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

function FindingDetailView({
  rpc,
  repo,
  number,
  findingId,
  onBack,
}: {
  rpc: Rpc;
  repo: string;
  number: number;
  findingId: string;
  onBack: () => void;
}) {
  const panel = experimental_useAppPanel();
  const [contextStep, setContextStep] = useState(0);
  const context = CONTEXT_STEPS[contextStep] ?? CONTEXT_STEPS[0];

  const pr = useLiveQuery(() => rpc.call("getPullRequest", { repo, number }), [rpc, repo, number]);
  const code = useLiveQuery(
    () => rpc.call("getFindingCode", { findingId, context }),
    [rpc, findingId, context],
  );

  const finding = useMemo(
    () => (pr.data?.findings ?? []).find((entry) => entry.id === findingId) ?? null,
    [pr.data, findingId],
  );

  const discuss = useCallback(
    (target: FindingDto) => {
      rpc.call("discussFinding", { findingId: target.id }).then((result) => {
        const opened = panel.openFixedTab({
          surface: { kind: "current" },
          tab: discussionTabRef,
          target: { threadId: result.threadId, title: target.title },
        });
        if (!opened) toast.error("Could not open the discussion tab.");
      }, reportError);
    },
    [rpc, panel],
  );

  if (pr.isLoading && pr.data === null) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} label="All issues" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }
  if (finding === null) {
    return (
      <div className="flex flex-col gap-3">
        <BackButton onBack={onBack} label="All issues" />
        <EmptyState
          icon="Bug"
          title="This issue is gone"
          detail="It was probably replaced by a re-run of the review."
        />
      </div>
    );
  }

  const locations: LocationDto[] = code.data?.locations ?? [];
  const nextContext = CONTEXT_STEPS[contextStep + 1];

  return (
    <div className="flex flex-col gap-4">
      <BackButton onBack={onBack} label="All issues" />

      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="flex items-start gap-2">
          <SeverityBadge severity={finding.severity} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-snug">{finding.title}</h2>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {locationLabel(finding)}
              {finding.category === "" ? "" : ` · ${finding.category}`}
            </p>
          </div>
          {finding.state === "posted" ? (
            <Badge variant="outline" className="shrink-0 gap-1 border-border">
              <Icon name="Check" className="size-3" />
              {finding.postedAs === "pending-review" ? "drafted" : "posted"}
            </Badge>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          {finding.background === "" ? null : (
            <Field label="Background" value={finding.background} />
          )}
          <Field label="Problem" value={finding.problem} />
          {finding.suggestedFix === "" ? null : (
            <Field label="Suggested fix" value={finding.suggestedFix} />
          )}
        </div>

        <FindingActions
          rpc={rpc}
          finding={finding}
          diffUrl={locations.find((location) => location.isPrimary)?.diffUrl}
          primaryLocation={locations.find((location) => location.isPrimary)}
          hasPendingReview={pr.data?.hasPendingReview ?? false}
          onDiscuss={discuss}
        />
      </div>

      <Section
        title={`Code${locations.length > 0 ? ` (${locations.length})` : ""}`}
        action={
          locations.length === 0 ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setContextStep((step) => (step + 1) % CONTEXT_STEPS.length)}
            >
              {nextContext === undefined ? "Less context" : `More context (±${nextContext})`}
            </Button>
          )
        }
      >
        {code.data !== null && !code.data.isReviewedCommit && locations.length > 0 ? (
          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            This code is the pull request&apos;s current head, not the commit the review ran
            against — that commit was not recorded. Line numbers may have moved since the issue
            was written.
          </p>
        ) : null}
        {code.error !== null ? (
          <EmptyState icon="AlertTriangle" title="Could not load the code" detail={code.error} />
        ) : code.isLoading && code.data === null ? (
          <Skeleton className="h-40 w-full rounded-lg" />
        ) : locations.length === 0 ? (
          <EmptyState icon="Code" title="No code to show" detail="This issue cites no file." />
        ) : (
          <div className="flex flex-col gap-3">
            {locations.map((location) => (
              <LocationCard
                key={`${location.file}:${location.startLine ?? ""}`}
                location={location}
              />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function BackButton({ onBack, label }: { onBack: () => void; label: string }) {
  return (
    <Button variant="ghost" size="sm" className="h-7 w-fit gap-1 px-1.5 text-xs" onClick={onBack}>
      <Icon name="ChevronLeft" className="size-3.5" />
      {label}
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

  const status = useLiveQuery(() => rpc.call("status"), [rpc]);
  const repos = useMemo(() => status.data?.repos ?? [], [status.data]);
  const hasRepos = status.data !== null;

  // Repo and filter live on the server, so re-opening the tab resumes instead
  // of asking again.
  const [repo, setRepo] = useState<string | null>(null);
  const [filter, setFilter] = useState<PrFilter>({ kind: "mine" });
  const [isRestored, setIsRestored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const done = () => {
      if (!cancelled) setIsRestored(true);
    };
    rpc.call("getPanelState").then((state) => {
      if (cancelled) return;
      if (state.repo !== null) setRepo(state.repo);
      if (state.filter !== null) setFilter(state.filter as PrFilter);
      done();
    }, done);
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  // Fall back to the first known repo only once BOTH the saved repo and the
  // repo list have arrived. `status` runs a gh auth probe, so it lands well
  // after `getPanelState`; acting on an empty list in that gap threw the saved
  // repo away and always landed on the first one.
  const repoKey = repos.join("\n");
  useEffect(() => {
    if (!isRestored || !hasRepos) return;
    setRepo((current) =>
      current !== null && repos.includes(current) ? current : (repos[0] ?? null),
    );
    // `repos` is rebuilt on every status refetch; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRestored, hasRepos, repoKey]);

  const persist = useCallback(
    (next: { repo?: string; filter?: PrFilter }) => {
      rpc
        .call("setPanelState", {
          repo: next.repo ?? repo,
          filter: next.filter ?? filter,
        })
        // Losing the saved position is not worth interrupting the user for.
        .catch(() => undefined);
    },
    [rpc, repo, filter],
  );

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
        ) : route.kind === "finding" ? (
          <FindingDetailView
            rpc={rpc}
            repo={route.repo}
            number={route.number}
            findingId={route.findingId}
            onBack={() => go({ kind: "pr", repo: route.repo, number: route.number })}
          />
        ) : route.kind === "pr" ? (
          <PrFindingsView
            rpc={rpc}
            repo={route.repo}
            number={route.number}
            skills={status.data?.skills ?? []}
            onBack={() => go({ kind: "list" })}
            onOpenFinding={(findingId) =>
              go({ kind: "finding", repo: route.repo, number: route.number, findingId })
            }
          />
        ) : (
          <PrListView
            rpc={rpc}
            repo={repo}
            repos={repos}
            filter={filter}
            onRepoChange={(next) => {
              setRepo(next);
              persist({ repo: next });
            }}
            onFilterChange={(next) => {
              setFilter(next);
              persist({ filter: next });
            }}
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
