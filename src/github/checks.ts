import type { Octokit } from "@octokit/rest";

type PreviewArgs = {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
};

async function findPreviewFromDeployments(args: PreviewArgs): Promise<string | null> {
  const { octokit, owner, repo, ref } = args;
  const deployments = await octokit.repos.listDeployments({
    owner,
    repo,
    ref,
    per_page: 10,
  });

  for (const deployment of deployments.data) {
    const statuses = await octokit.repos.listDeploymentStatuses({
      owner,
      repo,
      deployment_id: deployment.id,
      per_page: 10,
    });

    for (const status of statuses.data) {
      if (status.environment_url) return status.environment_url;
      if (status.target_url) return status.target_url;
    }
  }

  return null;
}

async function findPreviewFromChecks(args: PreviewArgs): Promise<string | null> {
  const { octokit, owner, repo, ref } = args;
  const checks = await octokit.checks.listForRef({
    owner,
    repo,
    ref,
    per_page: 20,
  });

  for (const check of checks.data.check_runs) {
    const name = (check.name ?? "").toLowerCase();
    const appSlug = check.app?.slug ?? "";
    if (name.includes("vercel") || appSlug === "vercel") {
      if (check.details_url) return check.details_url;
      if (check.html_url) return check.html_url;
    }
  }

  return null;
}

export async function findPreviewUrl(args: PreviewArgs): Promise<string | null> {
  const fromDeployments = await findPreviewFromDeployments(args);
  if (fromDeployments) return fromDeployments;
  return findPreviewFromChecks(args);
}

export async function waitForPreviewUrl(args: PreviewArgs & { attempts?: number; delayMs?: number }): Promise<string | null> {
  const { attempts = 8, delayMs = 10000, ...lookupArgs } = args;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const url = await findPreviewUrl(lookupArgs);
    if (url) return url;
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return null;
}
