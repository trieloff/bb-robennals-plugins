// One GraphQL search returns every field the list needs, so a refresh is two
// requests rather than two searches plus a `gh pr view` per pull request — at
// ~2.6s each those serialized into more than the host call deadline allows.
export const PULL_REQUEST_SEARCH_DOCUMENT = `query($q: String!, $limit: Int!) {
  search(query: $q, type: ISSUE, first: $limit) {
    nodes {
      ... on PullRequest {
        number title url state isDraft headRefName baseRefName
        createdAt updatedAt mergedAt reviewDecision
        repository { nameWithOwner }
        reviewRequests(first: 20) {
          nodes { requestedReviewer { ... on User { login } ... on Team { slug } ... on Mannequin { login } } }
        }
        commits(last: 1) {
          nodes { commit { statusCheckRollup { contexts(first: 100) {
            nodes { ... on CheckRun { status conclusion } ... on StatusContext { state } }
          } } } }
        }
      }
    }
  }
}`;

// `archived:false` keeps out pull requests in archived repositories: they
// cannot be reviewed, updated or merged, so listing one is only noise.
function searchQuery(filters: string[]): string {
  return ["author:@me", "is:pr", "archived:false", ...filters, "sort:updated-desc"].join(" ");
}
export function openPullRequestQuery(): string {
  return searchQuery(["state:open"]);
}
export function mergedPullRequestQuery(since: string): string {
  return searchQuery(["is:merged", `merged:>=${since}`]);
}
export function pullRequestSearchArgs(query: string, limit: number): string[] {
  return ["api", "graphql", "-f", `query=${PULL_REQUEST_SEARCH_DOCUMENT}`, "-f", `q=${query}`, "-F", `limit=${limit}`];
}
