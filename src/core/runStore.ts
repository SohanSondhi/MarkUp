import type { PlanResponse } from "./types.js";

export type RunStatus =
  | "PLANNING"
  | "AWAITING_CLARIFICATION"
  | "AWAITING_APPROVAL"
  | "AWAITING_REVISION"
  | "PATCHING"
  | "DONE"
  | "FAILED";

export type RunRecord = {
  runId: string;
  threadTs: string;
  channel: string;
  request: string;
  status: RunStatus;
  plan?: PlanResponse;
  planMessageTs?: string;
  createdAt: number;
  updatedAt: number;
};

const runsById = new Map<string, RunRecord>();
const runsByThread = new Map<string, string>();

export function createRun(args: { runId: string; threadTs: string; channel: string; request: string }): RunRecord {
  const now = Date.now();
  const record: RunRecord = {
    runId: args.runId,
    threadTs: args.threadTs,
    channel: args.channel,
    request: args.request,
    status: "PLANNING",
    createdAt: now,
    updatedAt: now,
  };
  runsById.set(record.runId, record);
  runsByThread.set(record.threadTs, record.runId);
  return record;
}

export function getRunById(runId: string): RunRecord | undefined {
  return runsById.get(runId);
}

export function getRunByThread(threadTs: string): RunRecord | undefined {
  const runId = runsByThread.get(threadTs);
  if (!runId) return undefined;
  return runsById.get(runId);
}

export function updateRun(runId: string, updates: Partial<RunRecord>): RunRecord | undefined {
  const existing = runsById.get(runId);
  if (!existing) return undefined;
  const next = { ...existing, ...updates, updatedAt: Date.now() };
  runsById.set(runId, next);
  return next;
}
