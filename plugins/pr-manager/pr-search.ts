const SEARCH_JSON_FIELDS = "number,title,url,repository,createdAt,updatedAt,isDraft";

// `gh search prs` includes archived repositories by default, but a pull request
// in an archived repository cannot be reviewed, updated or merged, so listing
// one is only noise. `--archived=false` drops them from both searches.
function searchArgs(filters: string[]): string[] {
  return ["search", "prs", "--author=@me", "--archived=false", ...filters,
    "--sort=updated", "--order=desc", "--json", SEARCH_JSON_FIELDS];
}
export function openPullRequestSearchArgs(limit: number): string[] {
  return searchArgs(["--state=open", `--limit=${limit}`]);
}
export function mergedPullRequestSearchArgs(since: string, limit: number): string[] {
  return searchArgs(["--merged", `--merged-at=>=${since}`, `--limit=${limit}`]);
}
