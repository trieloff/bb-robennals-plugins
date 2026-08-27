import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const normalizedPullRequestSchema = z.object({
  repository: z.string(), number: z.number().int().positive(), title: z.string(), url: z.string().url(),
  status: z.enum(["WAITING", "FAILING", "FEEDBACK", "APPROVED", "MERGED"]), summary: z.string(),
  isDraft: z.boolean(), headRefName: z.string(), baseRefName: z.string(), createdAt: z.string(), updatedAt: z.string(), mergedAt: z.string().nullable(),
});
export const hostContract = defineRpcContract({
  listPullRequests: {
    input: z.object({ mergedWithinDays: z.number().int().min(1).max(90), maximumPullRequests: z.number().int().min(1).max(100) }),
    output: z.object({ pullRequests: z.array(normalizedPullRequestSchema) }),
  },
  preparePullRequestBranch: {
    input: z.object({ projectPath: z.string().min(1), repository: z.string().regex(/^[^/]+\/[^/]+$/), number: z.number().int().positive() }),
    output: z.object({ ref: z.string() }),
  },
});
