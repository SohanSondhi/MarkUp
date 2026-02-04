import type { GuardConfig } from "./types.js";

export enum RunStep {
  INTAKE = "INTAKE",
  PLAN = "PLAN",
  PATCH = "PATCH",
  VALIDATE = "VALIDATE",
  PR_OPEN = "PR_OPEN",
  PREVIEW = "PREVIEW",
  DONE = "DONE",
  FAILED = "FAILED",
}

export type RunContext = {
  runId: string;
  request: string;
  step: RunStep;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  maxAttempts: number;
  config?: GuardConfig;
  previewUrl?: string;
  prNumber?: number;
  branchName?: string;
};
