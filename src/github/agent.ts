import type { Octokit } from "@octokit/rest";
import { createPrSimple, type FileEdit } from "./pr.js";
import { listRepoFiles, getFileContent, getDefaultBranch, searchRepoFiles } from "./repo.js";
import { waitForPreviewUrl } from "./checks.js";
import { assertFrontendEdits } from "../core/orchestrator.js";

type AgentEdits = {
  summary?: string;
  edits: FileEdit[];
};

const DEFAULT_MODEL = "gemini-3-flash-preview";
const MAX_FILES_FOR_CONTEXT = 6;
const RETRY_MAX_FILES_FOR_CONTEXT = 12;
const MAX_FILE_CONTENT_CHARS = 20000;
const MAX_LISTED_FILES = 40;
const MAX_SEARCH_TOKENS = 4;

const STOPWORDS = new Set([
  "add",
  "update",
  "change",
  "make",
  "create",
  "build",
  "page",
  "section",
  "component",
  "feature",
  "please",
  "with",
  "that",
  "this",
  "from",
  "into",
  "onto",
  "need",
  "want",
  "for",
  "and",
  "the",
  "our",
  "your",
  "should",
  "could",
  "would",
  "can",
]);

function normalizePrefix(raw: string): string {
  return raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function normalizeModel(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("models/") ? trimmed.slice("models/".length) : trimmed;
}

function getFrontendRoot(): string {
  return normalizePrefix(process.env.FRONTEND_ROOT ?? "frontend");
}

function tokenizeRequest(request: string): string[] {
  return request
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((token) => token.length >= 3);
}

function filterSearchTokens(tokens: string[]): string[] {
  return tokens.filter((token) => !STOPWORDS.has(token));
}

function pickSearchTokens(request: string): string[] {
  const tokens = filterSearchTokens(tokenizeRequest(request));
  if (tokens.length === 0) return tokenizeRequest(request).slice(0, MAX_SEARCH_TOKENS);
  return tokens.slice(0, MAX_SEARCH_TOKENS);
}

function scorePath(path: string, tokens: string[]): number {
  const lower = path.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lower.includes(token)) score += 2;
  }
  if (lower.includes("page") || lower.includes("pages")) score += 1;
  if (lower.includes("product")) score += 1;
  return score;
}

function pickEntryFiles(allPaths: string[]): string[] {
  const entryNames = new Set([
    "app.tsx",
    "app.jsx",
    "app.ts",
    "main.tsx",
    "main.jsx",
    "index.tsx",
    "index.jsx",
    "routes.tsx",
    "router.tsx",
  ]);

  return allPaths.filter((path) => {
    const name = path.split("/").pop()?.toLowerCase();
    return name ? entryNames.has(name) : false;
  });
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function pickCandidateFiles(allPaths: string[], request: string): string[] {
  const tokens = tokenizeRequest(request);
  const scored = allPaths.map((path) => ({
    path,
    score: scorePath(path, tokens),
  }));

  const withScore = scored.filter((item) => item.score > 0);
  withScore.sort((a, b) => b.score - a.score);

  let picks = withScore.slice(0, MAX_FILES_FOR_CONTEXT).map((item) => item.path);
  if (picks.length > 0) return picks;

  const fallbackKeywords = ["product", "pricing", "home", "index", "app", "page", "route"];
  const fallback = allPaths.filter((path) =>
    fallbackKeywords.some((keyword) => path.toLowerCase().includes(keyword))
  );
  picks = fallback.slice(0, MAX_FILES_FOR_CONTEXT);
  if (picks.length > 0) return picks;

  return allPaths.slice(0, MAX_FILES_FOR_CONTEXT);
}

function formatFileList(paths: string[]): string {
  return paths.slice(0, MAX_LISTED_FILES).map((path) => `- ${path}`).join("\n");
}

function formatFileContents(files: { path: string; content: string }[]): string {
  return files
    .map((file) => `--- path: ${file.path}\n${file.content}\n--- end`)
    .join("\n\n");
}

function buildPrompt(args: {
  request: string;
  frontendRoot: string;
  availableFiles: string[];
  fileContents: { path: string; content: string }[];
  forceEdit: boolean;
}): string {
  const { request, frontendRoot, availableFiles, fileContents, forceEdit } = args;
  return [
    "You are a coding agent for a frontend-only repo.",
    `Only edit files under "${frontendRoot}/".`,
    "Prefer reusing existing components; do not invent new ones unless necessary.",
    "Only edit files whose full contents are provided below.",
    "Return strict JSON only (no markdown).",
    "JSON shape:",
    '{"summary":"short summary","edits":[{"path":"frontend/...","content":"FULL FILE CONTENT"}]}',
    "",
    `REQUEST:\n${request}`,
    "",
    "AVAILABLE FILES (subset):",
    formatFileList(availableFiles),
    "",
    "FILE CONTENTS:",
    formatFileContents(fileContents),
    "",
    forceEdit
      ? "You must return at least one edit. If uncertain, choose the best matching page and add a minimal, sensible change."
      : "If no change is possible, return {\"summary\":\"No safe change\",\"edits\":[]}.",
  ].join("\n");
}

function extractJson(text: string): AgentEdits {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Gemini response did not contain JSON.");
  }

  const jsonText = raw.slice(start, end + 1).trim();
  const parsed = JSON.parse(jsonText) as AgentEdits;

  if (!parsed || !Array.isArray(parsed.edits)) {
    throw new Error("Gemini response JSON is missing the edits array.");
  }

  return parsed;
}

async function callGemini(prompt: string): Promise<AgentEdits> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY");

  const model = normalizeModel(process.env.GEMINI_MODEL ?? DEFAULT_MODEL);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const fetchFn = globalThis.fetch;
  if (!fetchFn) {
    throw new Error("Global fetch is not available in this runtime.");
  }

  const response = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed (${response.status}): ${errorText}`);
  }

  const payload = await response.json();
  const text = payload?.candidates?.[0]?.content?.parts
    ?.map((part: { text?: string }) => part.text ?? "")
    .join("") ?? "";

  if (!text) throw new Error("Gemini response was empty.");
  return extractJson(text);
}

function normalizeEdits(edits: AgentEdits["edits"]): FileEdit[] {
  return edits
    .map((edit) => ({
      path: String(edit.path ?? "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+/, ""),
      content: String(edit.content ?? ""),
    }))
    .filter((edit) => edit.path.length > 0);
}

async function collectFileContents(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
  paths: string[];
  maxFiles: number;
}): Promise<{ path: string; content: string }[]> {
  const { octokit, owner, repo, ref, paths, maxFiles } = args;
  const fileContents: { path: string; content: string }[] = [];

  for (const path of paths.slice(0, maxFiles)) {
    const content = await getFileContent({ octokit, owner, repo, path, ref });
    if (content.length > MAX_FILE_CONTENT_CHARS) continue;
    fileContents.push({ path, content });
  }

  return fileContents;
}

async function findCandidatePaths(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  frontendRoot: string;
  allPaths: string[];
  request: string;
}): Promise<string[]> {
  const { octokit, owner, repo, frontendRoot, allPaths, request } = args;
  const searchTokens = pickSearchTokens(request);

  const searchHits: string[] = [];
  for (const token of searchTokens) {
    const results = await searchRepoFiles({
      octokit,
      owner,
      repo,
      query: token,
      prefix: frontendRoot,
      perPage: 8,
    });
    searchHits.push(...results);
  }

  const entryFiles = pickEntryFiles(allPaths);
  const pathScored = pickCandidateFiles(allPaths, request);

  return dedupePaths([...searchHits, ...entryFiles, ...pathScored]);
}

export async function createPrFromAgent(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  request: string;
  branchName: string;
  title: string;
  body?: string;
}): Promise<{
  prUrl: string;
  prNumber: number;
  baseBranch: string;
  previewUrl: string | null;
  summary?: string;
  edits: FileEdit[];
}> {
  const { octokit, owner, repo, request, branchName, title, body } = args;
  const frontendRoot = getFrontendRoot();

  const baseBranch = await getDefaultBranch({ octokit, owner, repo });
  const repoFiles = await listRepoFiles({
    octokit,
    owner,
    repo,
    ref: baseBranch,
    prefix: frontendRoot,
  });

  const allPaths = repoFiles.map((file) => file.path);
  const candidates = await findCandidatePaths({
    octokit,
    owner,
    repo,
    frontendRoot,
    allPaths,
    request,
  });

  const fileContents = await collectFileContents({
    octokit,
    owner,
    repo,
    ref: baseBranch,
    paths: candidates,
    maxFiles: MAX_FILES_FOR_CONTEXT,
  });

  if (fileContents.length === 0) {
    throw new Error("No suitable frontend files found to provide to the agent.");
  }

  const prompt = buildPrompt({
    request,
    frontendRoot,
    availableFiles: allPaths,
    fileContents,
    forceEdit: false,
  });

  let agentResponse = await callGemini(prompt);
  let normalizedEdits = normalizeEdits(agentResponse.edits);

  if (normalizedEdits.length === 0) {
    const retryContents = await collectFileContents({
      octokit,
      owner,
      repo,
      ref: baseBranch,
      paths: candidates,
      maxFiles: RETRY_MAX_FILES_FOR_CONTEXT,
    });

    const retryPrompt = buildPrompt({
      request,
      frontendRoot,
      availableFiles: allPaths,
      fileContents: retryContents,
      forceEdit: true,
    });

    agentResponse = await callGemini(retryPrompt);
    normalizedEdits = normalizeEdits(agentResponse.edits);
  }

  if (normalizedEdits.length === 0) {
    throw new Error(
      "Gemini did not return any edits. Try adding the target page or component name to the request."
    );
  }

  const existingPaths = new Set(allPaths.map((path) => path.toLowerCase()));
  const newFiles = normalizedEdits.filter((edit) => !existingPaths.has(edit.path.toLowerCase()));
  if (newFiles.length > 0) {
    const paths = newFiles.map((edit) => edit.path).join(", ");
    throw new Error(`Agent attempted to create new files (not allowed): ${paths}`);
  }

  assertFrontendEdits(normalizedEdits);

  const prBody =
    body ??
    [
      "Automated PR generated from a Slack request.",
      "",
      `Request: ${request}`,
      agentResponse.summary ? `\nAgent summary: ${agentResponse.summary}` : "",
    ].join("\n");

  const { prUrl, prNumber, baseBranch: prBaseBranch } = await createPrSimple({
    octokit,
    owner,
    repo,
    branchName,
    title,
    body: prBody,
    edits: normalizedEdits,
  });

  const previewUrl = await waitForPreviewUrl({
    octokit,
    owner,
    repo,
    ref: branchName,
  });

  return {
    prUrl,
    prNumber,
    baseBranch: prBaseBranch,
    previewUrl,
    summary: agentResponse.summary,
    edits: normalizedEdits,
  };
}
