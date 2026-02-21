import crypto from "crypto";
import { makeOctokit } from "../github/client.js";
import { createPlanForRequest, runApprovedPlan } from "../github/agent.js";
import { createRun, getRunById, getRunByThread, updateRun, type RunRecord } from "../core/runStore.js";
import type { PlanResponse } from "../core/types.js";

const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

class RequestTimeoutError extends Error {
  constructor(message = "Request exceeded time limit.") {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

function isTimeoutError(err: unknown): boolean {
  return err instanceof RequestTimeoutError || (err as Error | undefined)?.name === "RequestTimeoutError";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    throw new RequestTimeoutError(`${label} exceeded the 3 minute time limit.`);
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new RequestTimeoutError(`${label} exceeded the 3 minute time limit.`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function formatPlanSummary(plan: PlanResponse): string {
  const lines = [
    "*Plan Summary*",
    plan.summary ? `Summary: ${plan.summary}` : "Summary: (none)",
    `Target URL: ${plan.targetUrlPath || "/"}`,
  ];
  return lines.join("\n");
}

function buildPlanBlocks(plan: PlanResponse, runId: string) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: formatPlanSummary(plan) },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve Plan" },
          style: "primary",
          action_id: "markup_approve_plan",
          value: runId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Revise Plan" },
          action_id: "markup_revise_plan",
          value: runId,
        },
      ],
    },
  ];
}

async function planAndRespond(args: {
  run: RunRecord;
  request: string;
  say: any;
  logger: any;
}) {
  const { run, request, say, logger } = args;
  const octokit = makeOctokit();
  const owner = process.env.GITHUB_OWNER!;
  const repo = process.env.GITHUB_REPO!;

  let plan: PlanResponse;
  try {
    plan = await withTimeout(
      createPlanForRequest({
        octokit,
        owner,
        repo,
        request,
      }),
      REQUEST_TIMEOUT_MS,
      "Planning"
    );
  } catch (err: any) {
    if (isTimeoutError(err)) {
      updateRun(run.runId, { status: "FAILED" });
      await say({
        thread_ts: run.threadTs,
        text: "Request timed out after 3 minutes while planning. Please try again.",
      });
      return;
    }
    throw err;
  }

  updateRun(run.runId, { plan, request });
  logger.info(
    {
      runId: run.runId,
      targetPaths: plan.targetPaths,
      risks: plan.risks,
      confidence: plan.confidence,
    },
    "Plan metadata"
  );

  if (plan.openQuestions?.length) {
    updateRun(run.runId, { status: "AWAITING_CLARIFICATION" });
    await say({
      thread_ts: run.threadTs,
      text: `I have a couple questions before I proceed:\n- ${plan.openQuestions.join("\n- ")}`,
    });
    return;
  }

  const planMessage = await say({
    thread_ts: run.threadTs,
    text: "Plan ready. Please approve or request revisions.",
    blocks: buildPlanBlocks(plan, run.runId),
  });

  updateRun(run.runId, {
    status: "AWAITING_APPROVAL",
    planMessageTs: planMessage?.ts,
  });

  logger.info({ runId: run.runId }, "Plan ready for approval");
}

export function registerHandlers(app: any) {
  app.event("app_mention", async ({ event, say, logger }: any) => {
    const text = event.text ?? "";
    const cleaned = text.replace(/<@[^>]+>/g, "").trim();
    const threadTs = event.thread_ts ?? event.ts;
    const channel = event.channel;

    if (!cleaned) {
      await say({
        thread_ts: threadTs,
        text: `Send a request like:\n"@markup add a FAQ at the bottom for the return policy"`,
      });
      return;
    }

    const existingRun = getRunByThread(threadTs);
    if (existingRun) {
      if (existingRun.status === "AWAITING_CLARIFICATION") {
        updateRun(existingRun.runId, { status: "PLANNING" });
        await say({ thread_ts: threadTs, text: "Thanks! Updating the plan with your answers..." });
        const updatedRequest = `${existingRun.request}\nClarifications: ${cleaned}`;
        try {
          await planAndRespond({ run: existingRun, request: updatedRequest, say, logger });
        } catch (err: any) {
          logger.error(err, "Failed to update plan");
          updateRun(existingRun.runId, { status: "FAILED" });
          await say({
            thread_ts: threadTs,
            text: `Failed to update plan.\n${err?.message ?? err}`,
          });
        }
        return;
      }

      if (existingRun.status === "AWAITING_REVISION") {
        updateRun(existingRun.runId, { status: "PLANNING" });
        await say({ thread_ts: threadTs, text: "Got it. Revising the plan..." });
        const updatedRequest = `${existingRun.request}\nRevision request: ${cleaned}`;
        try {
          await planAndRespond({ run: existingRun, request: updatedRequest, say, logger });
        } catch (err: any) {
          logger.error(err, "Failed to update plan");
          updateRun(existingRun.runId, { status: "FAILED" });
          await say({
            thread_ts: threadTs,
            text: `Failed to update plan.\n${err?.message ?? err}`,
          });
        }
        return;
      }

      if (existingRun.status === "AWAITING_APPROVAL") {
        await say({
          thread_ts: threadTs,
          text: "The plan is waiting for approval. Use the buttons above to approve or revise.",
        });
        return;
      }

      if (existingRun.status === "PATCHING") {
        await say({ thread_ts: threadTs, text: "Still working on the approved plan. Hang tight." });
        return;
      }

      if (existingRun.status === "DONE") {
        await say({
          thread_ts: threadTs,
          text: "This run is complete. Start a new request in a fresh thread to begin again.",
        });
        return;
      }

      if (existingRun.status === "FAILED") {
        await say({
          thread_ts: threadTs,
          text: "The previous run failed. Start a new request in a fresh thread to begin again.",
        });
        return;
      }

      await say({
        thread_ts: threadTs,
        text: "This run is already in progress. Please wait for it to finish.",
      });
      return;
    }

    const runId = crypto.randomBytes(3).toString("hex");
    const run = createRun({ runId, threadTs, channel, request: cleaned });
    logger.info({ runId, cleaned }, "New request");

    await say({
      thread_ts: threadTs,
      text: `Working on it (job ${runId}).\nRequest: "${cleaned}"`,
    });

    await say({ thread_ts: threadTs, text: "Analyzing the request and selecting target files..." });

    try {
      await planAndRespond({ run, request: cleaned, say, logger });
    } catch (err: any) {
      logger.error(err, "Failed to create plan");
      updateRun(run.runId, { status: "FAILED" });
      await say({
        thread_ts: threadTs,
        text: `Failed to create plan.\n${err?.message ?? err}`,
      });
    }
  });

  // Clarifications and revisions are handled via @markup mentions inside the thread.

  app.action("markup_approve_plan", async ({ body, ack, say, logger, client }: any) => {
    await ack();
    const runId = body?.actions?.[0]?.value;
    const run = runId ? getRunById(runId) : undefined;

    if (!run) {
      await say({ thread_ts: body?.message?.thread_ts ?? body?.message?.ts, text: "Run not found." });
      return;
    }

    if (run.status !== "AWAITING_APPROVAL") {
      await say({ thread_ts: run.threadTs, text: "This plan is not awaiting approval." });
      return;
    }

    if (!run.plan) {
      await say({ thread_ts: run.threadTs, text: "Plan data is missing. Please retry." });
      return;
    }

    updateRun(run.runId, { status: "PATCHING" });
    await say({ thread_ts: run.threadTs, text: "Plan approved. Generating patch and opening a PR..." });

    try {
      const octokit = makeOctokit();
      const owner = process.env.GITHUB_OWNER!;
      const repo = process.env.GITHUB_REPO!;

      const result = await withTimeout(
        runApprovedPlan({
          octokit,
          owner,
          repo,
          request: run.request,
          plan: run.plan,
          branchName: `markup/${run.runId}`,
          title: `Markup: ${run.request.slice(0, 60)}`,
        }),
        REQUEST_TIMEOUT_MS,
        "Patch + PR"
      );

      await say({
        thread_ts: run.threadTs,
        text: `PR created successfully:\n${result.prUrl}${result.summary ? `\nSummary: ${result.summary}` : ""}`,
      });

      if (result.previewUrl) {
        await say({ thread_ts: run.threadTs, text: `Vercel preview ready:\n${result.previewUrl}` });
      } else {
        await say({
          thread_ts: run.threadTs,
          text: "Preview link is still building. Check the PR deployments shortly.",
        });
      }

      updateRun(run.runId, { status: "DONE" });
    } catch (err: any) {
      if (isTimeoutError(err)) {
        updateRun(run.runId, { status: "FAILED" });
        await say({
          thread_ts: run.threadTs,
          text: "Request timed out after 3 minutes while generating the PR. Please try again.",
        });
        return;
      }
      logger.error(err, "Failed to create PR");
      updateRun(run.runId, { status: "FAILED" });
      await say({
        thread_ts: run.threadTs,
        text: `Failed to create PR.\n${err?.message ?? err}`,
      });
    }
  });

  app.action("markup_revise_plan", async ({ body, ack, say }: any) => {
    await ack();
    const runId = body?.actions?.[0]?.value;
    const run = runId ? getRunById(runId) : undefined;

    if (!run) {
      await say({ thread_ts: body?.message?.thread_ts ?? body?.message?.ts, text: "Run not found." });
      return;
    }

    updateRun(run.runId, { status: "AWAITING_REVISION" });
    await say({
      thread_ts: run.threadTs,
      text: "Please reply in this thread with the revisions and mention me.",
    });
  });
}
