import type { Octokit } from "@octokit/rest";

export type FileEdit = {
  path: string;     // e.g. "apps/web/app/returns/page.tsx"
  content: string;  // full file contents (utf8)
};

export async function createPrSimple(args: {
  octokit: Octokit;
  owner: string;
  repo: string;

  branchName: string; // must be unique for demo (e.g. markup/run-123)
  title: string;
  body?: string;

  edits: FileEdit[];
}): Promise<{ prUrl: string; prNumber: number; baseBranch: string }> {
  const { octokit, owner, repo, branchName, title, body, edits } = args;
  if (!edits?.length) throw new Error("No edits provided");

  // 1) Default branch
  const repoInfo = await octokit.repos.get({ owner, repo });
  const baseBranch = repoInfo.data.default_branch;
  if (!baseBranch) throw new Error("Could not determine default branch");

  // 2) Create new branch from base HEAD
  const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  const baseSha = baseRef.data.object.sha;

  await octokit.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // 3) Apply edits (each file update creates a commit; good for demos)
  for (const edit of edits) {
    // If file exists, we need its SHA; if not, omit SHA.
    let existingSha: string | undefined;
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: edit.path,
        ref: branchName,
      });
      if (!Array.isArray(data) && "sha" in data) existingSha = data.sha;
    } catch (e: any) {
      if (e?.status !== 404) throw e;
    }

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      branch: branchName,
      path: edit.path,
      message: `markup: ${title}`,
      content: Buffer.from(edit.content, "utf8").toString("base64"),
      sha: existingSha,
    });
  }

  // 4) Open PR
  const pr = await octokit.pulls.create({
    owner,
    repo,
    base: baseBranch,
    head: branchName,
    title,
    body: body ?? "",
  });

  if (!pr.data.html_url || !pr.data.number) throw new Error("Failed to create PR");

  return { prUrl: pr.data.html_url, prNumber: pr.data.number, baseBranch };
}

