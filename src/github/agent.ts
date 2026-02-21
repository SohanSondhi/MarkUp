import type { Octokit } from "@octokit/rest";
import * as path from "node:path";
import { createPrSimple, type FileEdit } from "./pr.js";
import { listRepoFiles, getFileContent, getDefaultBranch, searchRepoFiles } from "./repo.js";
import { waitForPreviewUrl } from "./checks.js";
import { assertFrontendEdits } from "../core/orchestrator.js";
import type { PlanResponse, PatchResponse } from "../core/types.js";

/* ────────────────────────────────────────────────────────────
 * GitLab Duo agent HTTP client
 *
 * The Duo agent runs as an external service and exposes two
 * endpoints that replace the previous Gemini-based planner and
 * patcher modules:
 *
 *   POST /plan  — accepts a request + file context, returns a plan
 *   POST /patch — accepts a request + plan + file contents, returns edits
 * ──────────────────────────────────────────────────────────── */

const DUO_AGENT_URL = process.env.DUO_AGENT_URL ?? "http://localhost:8200";
const DUO_AGENT_TIMEOUT_MS = 120_000;

type DuoPlanRequest = {
  request: string;
  frontendRoot: string;
  availableFiles: string[];
  fileContents: { path: string; content: string }[];
};

type DuoPatchRequest = {
  request: string;
  frontendRoot: string;
  availableFiles: string[];
  fileContents: { path: string; content: string }[];
  plan: PlanResponse;
  forceEdit: boolean;
};

async function callDuoAgent<TReq, TRes>(endpoint: string, body: TReq): Promise<TRes> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DUO_AGENT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DUO_AGENT_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Duo agent ${endpoint} failed (${response.status}): ${errorText}`);
    }

    return (await response.json()) as TRes;
  } finally {
    clearTimeout(timeout);
  }
}

async function duoPlan(args: DuoPlanRequest): Promise<PlanResponse> {
  return callDuoAgent<DuoPlanRequest, PlanResponse>("/plan", args);
}

async function duoPatch(args: DuoPatchRequest): Promise<PatchResponse> {
  return callDuoAgent<DuoPatchRequest, PatchResponse>("/patch", args);
}

function normalizeEdits(edits: PatchResponse["edits"]): FileEdit[] {
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

const MAX_PLAN_CONTEXT_FILES = 4;
const MAX_PLAN_BATCHES = 3;
const MAX_PATCH_CONTEXT_FILES = 8;
const RETRY_MAX_PATCH_CONTEXT_FILES = 10;
const MAX_FILE_CONTENT_CHARS = 10000;
const MAX_SEARCH_TOKENS = 4;
const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];
const INDEX_FILES = SOURCE_EXTENSIONS.map((ext) => `index${ext}`);

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

function buildPathLookup(allPaths: string[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const path of allPaths) {
    lookup.set(path.toLowerCase(), path);
  }
  return lookup;
}

function lookupPath(lookup: Map<string, string>, candidate: string): string | null {
  return lookup.get(candidate.toLowerCase()) ?? null;
}

function resolveWithExtensions(lookup: Map<string, string>, basePath: string): string | null {
  const direct = lookupPath(lookup, basePath);
  if (direct) return direct;

  for (const ext of SOURCE_EXTENSIONS) {
    const withExt = `${basePath}${ext}`;
    const found = lookupPath(lookup, withExt);
    if (found) return found;
  }

  for (const indexFile of INDEX_FILES) {
    const withIndex = path.posix.join(basePath, indexFile);
    const found = lookupPath(lookup, withIndex);
    if (found) return found;
  }

  return null;
}

function resolveImportPath(args: {
  importPath: string;
  fromPath: string;
  allPaths: string[];
  frontendRoot: string;
  lookup: Map<string, string>;
}): string | null {
  const { importPath, fromPath, allPaths, frontendRoot, lookup } = args;
  const cleaned = importPath.trim();
  if (!cleaned) return null;

  if (cleaned.startsWith(".")) {
    const baseDir = fromPath.split("/").slice(0, -1).join("/");
    const resolved = path.posix.normalize(path.posix.join(baseDir, cleaned));
    return resolveWithExtensions(lookup, resolved);
  }

  let normalized = cleaned;
  if (normalized.startsWith("@/") || normalized.startsWith("~/")) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }

  const rootCandidate = path.posix.join(frontendRoot, normalized);
  const resolvedFromRoot = resolveWithExtensions(lookup, rootCandidate);
  if (resolvedFromRoot) return resolvedFromRoot;

  const suffixes: string[] = [];
  for (const ext of SOURCE_EXTENSIONS) {
    suffixes.push(`${normalized}${ext}`);
  }
  for (const indexFile of INDEX_FILES) {
    suffixes.push(path.posix.join(normalized, indexFile));
  }

  for (const candidate of allPaths) {
    const lower = candidate.toLowerCase();
    if (suffixes.some((suffix) => lower.endsWith(suffix.toLowerCase()))) {
      return candidate;
    }
  }

  return null;
}

function extractImportPaths(content: string): string[] {
  const results = new Set<string>();
  const patterns = [
    /import\s+[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) results.add(match[1]);
    }
  }

  return Array.from(results);
}

function findRelatedPaths(args: {
  fileContents: { path: string; content: string }[];
  allPaths: string[];
  frontendRoot: string;
}): string[] {
  const { fileContents, allPaths, frontendRoot } = args;
  const lookup = buildPathLookup(allPaths);
  const related = new Set<string>();

  for (const file of fileContents) {
    const importPaths = extractImportPaths(file.content);
    for (const importPath of importPaths) {
      const resolved = resolveImportPath({
        importPath,
        fromPath: file.path,
        allPaths,
        frontendRoot,
        lookup,
      });
      if (resolved) related.add(resolved);
    }
  }

  return Array.from(related);
}

function findPathsByNameTokens(allPaths: string[], request: string): string[] {
  const rawTokens = filterSearchTokens(tokenizeRequest(request));
  if (rawTokens.length === 0) return [];

  const tokens = new Set(rawTokens);
  const addSynonyms = (entries: string[]) => {
    for (const entry of entries) tokens.add(entry);
  };

  if (tokens.has("navbar") || tokens.has("nav") || tokens.has("navigation")) {
    addSynonyms(["header", "topbar", "appbar", "menu", "nav", "navbar", "navigation", "layout"]);
  }
  if (tokens.has("header")) {
    addSynonyms(["navbar", "nav", "topbar", "layout"]);
  }
  if (tokens.has("menu")) {
    addSynonyms(["nav", "navbar", "navigation"]);
  }
  if (tokens.has("footer")) {
    addSynonyms(["bottom", "sitefooter"]);
  }

  const matchTokens = Array.from(tokens);
  const matches: string[] = [];
  for (const path of allPaths) {
    const base = path.split("/").pop()?.toLowerCase() ?? "";
    const name = base.replace(/\.[^.]+$/, "");
    if (matchTokens.some((token) => name.includes(token))) {
      matches.push(path);
    }
  }
  return matches;
}

function pickCandidateFiles(allPaths: string[], request: string): string[] {
  const tokens = tokenizeRequest(request);
  const scored = allPaths.map((path) => ({
    path,
    score: scorePath(path, tokens),
  }));

  const withScore = scored.filter((item) => item.score > 0);
  withScore.sort((a, b) => b.score - a.score);

  let picks = withScore.slice(0, MAX_PLAN_CONTEXT_FILES).map((item) => item.path);
  if (picks.length > 0) return picks;

  const fallbackKeywords = ["product", "pricing", "home", "index", "app", "page", "route"];
  const fallback = allPaths.filter((path) =>
    fallbackKeywords.some((keyword) => path.toLowerCase().includes(keyword))
  );
  picks = fallback.slice(0, MAX_PLAN_CONTEXT_FILES);
  if (picks.length > 0) return picks;

  return allPaths.slice(0, MAX_PLAN_CONTEXT_FILES);
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

function ensureNoNewFiles(edits: FileEdit[], allPaths: string[]): void {
  const existingPaths = new Set(allPaths.map((path) => path.toLowerCase()));
  const newFiles = edits.filter((edit) => !existingPaths.has(edit.path.toLowerCase()));
  if (newFiles.length > 0) {
    const paths = newFiles.map((edit) => edit.path).join(", ");
    throw new Error(`Agent attempted to create new files (not allowed): ${paths}`);
  }
}

function buildPrBody(request: string, summary?: string): string {
  return [
    "Automated PR generated from a Slack request.",
    "",
    `Request: ${request}`,
    summary ? `\nAgent summary: ${summary}` : "",
  ].join("\n");
}

export async function createPlanForRequest(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  request: string;
}): Promise<PlanResponse> {
  const { octokit, owner, repo, request } = args;
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

  const nameMatches = findPathsByNameTokens(allPaths, request);
  const prioritized = dedupePaths([...nameMatches, ...candidates]);
  const planCandidateLimit = MAX_PLAN_CONTEXT_FILES * MAX_PLAN_BATCHES;
  const planCandidates = prioritized.slice(0, planCandidateLimit);

  const planContents = await collectFileContents({
    octokit,
    owner,
    repo,
    ref: baseBranch,
    paths: planCandidates,
    maxFiles: planCandidateLimit,
  });

  if (planContents.length === 0) {
    throw new Error("No suitable frontend files found to provide to the planner.");
  }

  // Delegate planning to the GitLab Duo agent instead of Gemini
  const plan = await duoPlan({
    request,
    frontendRoot,
    availableFiles: allPaths,
    fileContents: planContents,
  });

  return plan;
}

export async function runApprovedPlan(args: {
  octokit: Octokit;
  owner: string;
  repo: string;
  request: string;
  plan: PlanResponse;
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
  const { octokit, owner, repo, request, plan, branchName, title, body } = args;
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

  const nameMatches = findPathsByNameTokens(allPaths, request);
  const prioritized = plan.targetPaths?.length
    ? dedupePaths([...plan.targetPaths, ...nameMatches, ...candidates])
    : dedupePaths([...nameMatches, ...candidates]);

  const baseContents = await collectFileContents({
    octokit,
    owner,
    repo,
    ref: baseBranch,
    paths: prioritized,
    maxFiles: MAX_PATCH_CONTEXT_FILES,
  });

  if (baseContents.length === 0) {
    throw new Error("No suitable frontend files found to provide to the patcher.");
  }

  const relatedPaths = findRelatedPaths({
    fileContents: baseContents,
    allPaths,
    frontendRoot,
  });

  const expandedPaths = relatedPaths.length > 0
    ? dedupePaths([...prioritized, ...relatedPaths])
    : prioritized;

  const fileContents = expandedPaths.length === prioritized.length
    ? baseContents
    : await collectFileContents({
        octokit,
        owner,
        repo,
        ref: baseBranch,
        paths: expandedPaths,
        maxFiles: MAX_PATCH_CONTEXT_FILES,
      });

  let patchResponse: PatchResponse = await duoPatch({
    request,
    frontendRoot,
    availableFiles: allPaths,
    fileContents,
    plan,
    forceEdit: false,
  });

  let normalizedEdits = normalizeEdits(patchResponse.edits);

  if (normalizedEdits.length === 0) {
    const retryContents = await collectFileContents({
      octokit,
      owner,
      repo,
      ref: baseBranch,
      paths: expandedPaths,
      maxFiles: RETRY_MAX_PATCH_CONTEXT_FILES,
    });

    patchResponse = await duoPatch({
      request,
      frontendRoot,
      availableFiles: allPaths,
      fileContents: retryContents,
      plan,
      forceEdit: true,
    });
    normalizedEdits = normalizeEdits(patchResponse.edits);
  }

  if (normalizedEdits.length === 0) {
    throw new Error(
      "Duo agent did not return any edits. Try adding the target page or component name to the request."
    );
  }

  ensureNoNewFiles(normalizedEdits, allPaths);
  assertFrontendEdits(normalizedEdits);

  const prBody = body ?? buildPrBody(request, patchResponse.summary);

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
    summary: patchResponse.summary,
    edits: normalizedEdits,
  };
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
  plan: PlanResponse;
}> {
  const plan = await createPlanForRequest({
    octokit: args.octokit,
    owner: args.owner,
    repo: args.repo,
    request: args.request,
  });

  const result = await runApprovedPlan({
    octokit: args.octokit,
    owner: args.owner,
    repo: args.repo,
    request: args.request,
    plan,
    branchName: args.branchName,
    title: args.title,
    body: args.body,
  });

  return { ...result, plan };
}
