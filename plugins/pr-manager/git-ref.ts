export function pullRequestSourceRef(number: number): string {
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error("Pull request number must be a positive integer.");
  return `refs/bb/pr-manager/pull/${number}`;
}
