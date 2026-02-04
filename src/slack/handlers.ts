import type { App } from "@slack/bolt";
import { workingOnItText, emptyRequestHelpText } from "./responses.js";
import crypto from "crypto";
import { makeOctokit } from "../github/client.js";
import { createPrFromAgent } from "../github/agent.js";

export function registerHandlers(app: any) {
  app.event("app_mention", async ({ event, say, logger }: any) => {
    const text = event.text ?? "";
    const cleaned = text.replace(/<@[^>]+>/g, "").trim();
    const thread_ts = event.ts;

    if (!cleaned) {
      await say({
        thread_ts,
        text: `Send a request like:\n"@markup add a FAQ at the bottom for the return policy"`,
      });
      return;
    }

    const jobId = crypto.randomBytes(3).toString("hex");
    logger.info({ jobId, cleaned }, "New request");

    await say({
      thread_ts,
      text: `Working on it (job ${jobId}).\nRequest: "${cleaned}"`,
    });

    await new Promise((r) => setTimeout(r, 800));
    await say({ thread_ts, text: "Analyzing the request..." });

    await new Promise((r) => setTimeout(r, 800));
    await say({ thread_ts, text: "Identifying the target page + UI components..." });

    await new Promise((r) => setTimeout(r, 800));
    await say({ thread_ts, text: "Next: I'll open a PR and share a preview link here." });

    try {
      const octokit = makeOctokit();
      const owner = process.env.GITHUB_OWNER!;
      const repo = process.env.GITHUB_REPO!;

      const { prUrl, previewUrl, summary } = await createPrFromAgent({
        octokit,
        owner,
        repo,
        branchName: `markup/${jobId}`,
        title: `Markup: ${cleaned.slice(0, 60)}`,
        request: cleaned,
      });

      await say({
        thread_ts,
        text: `PR created successfully:\n${prUrl}${summary ? `\nSummary: ${summary}` : ""}`,
      });

      if (previewUrl) {
        await say({
          thread_ts,
          text: `Vercel preview ready:\n${previewUrl}`,
        });
      } else {
        await say({
          thread_ts,
          text: "Preview link is still building. Check the PR deployments shortly.",
        });
      }
    } catch (err: any) {
      logger.error(err, "Failed to create PR");

      await say({
        thread_ts,
        text: `Failed to create PR.\n${err?.message ?? err}`,
      });
    }
  });
}
