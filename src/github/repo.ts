
import type { Octokit } from "@octokit/rest";

export type RepoFile = {
  path: string;
  sha: string;
  type: "blob" | "tree";
  size?: number;
};

function normalizePrefix(raw: string): string {
  return raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function isUnderPrefix(path: string, prefix: string): boolean {
  if (!prefix) return false;
  if (path === prefix) return true;
  return path.startsWith(`${prefix}/`);
}

export async function getDefaultBranch(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
}): Promise<string> {
  const { octokit, owner, repo } = args;
  const repoInfo = await octokit.repos.get({ owner, repo });
  const baseBranch = repoInfo.data.default_branch;
  if (!baseBranch) throw new Error("Could not determine default branch");
  return baseBranch;
}

async function getTreeSha(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  branch: string;
}): Promise<string> {
  const { octokit, owner, repo, branch } = args;
  const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
  const commit = await octokit.git.getCommit({ owner, repo, commit_sha: ref.data.object.sha });
  return commit.data.tree.sha;
}

export async function listRepoFiles(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  prefix?: string;
}): Promise<RepoFile[]> {
  const { octokit, owner, repo, ref, prefix } = args;
  const normalizedPrefix = prefix ? normalizePrefix(prefix) : "";

  const treeSha = await getTreeSha({ octokit, owner, repo, branch: ref });
  const { data } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: "1",
  });

  const files = (data.tree ?? []).filter((item): item is RepoFile => {
    return Boolean(item.path && item.sha && item.type);
  });

  const blobs = files.filter((item) => item.type === "blob");
  if (!normalizedPrefix) return blobs;
  return blobs.filter((item) => isUnderPrefix(item.path, normalizedPrefix));
}

export async function getFileContent(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  path: string;
  ref: string;
}): Promise<string> {
  const { octokit, owner, repo, path, ref } = args;
  const { data } = await octokit.repos.getContent({ owner, repo, path, ref });

  if (Array.isArray(data)) {
    throw new Error(`Path "${path}" is a directory, expected a file.`);
  }

  if (!data.content || data.encoding !== "base64") {
    throw new Error(`Unable to decode content for "${path}".`);
  }

  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function searchRepoFiles(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  query: string;
  prefix?: string;
  perPage?: number;
}): Promise<string[]> {
  const { octokit, owner, repo, query, prefix, perPage = 10 } = args;
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const normalizedPrefix = prefix ? normalizePrefix(prefix) : "";
  const qualifiers = [`repo:${owner}/${repo}`];
  if (normalizedPrefix) {
    qualifiers.push(`path:${normalizedPrefix}`);
  }

  const q = `${trimmedQuery} ${qualifiers.join(" ")}`.trim();
  const { data } = await octokit.search.code({
    q,
    per_page: perPage,
  });

  return (data.items ?? [])
    .map((item) => item.path)
    .filter((path): path is string => typeof path === "string");
}
