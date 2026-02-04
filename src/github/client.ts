import { Octokit } from "@octokit/rest";

export function makeOctokit() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Missing GITHUB_TOKEN");
  return new Octokit({ auth: token });
}