
import type { FileEdit, GuardConfig, GuardResult, GuardViolation } from "./types.js";

const DEFAULT_FRONTEND_ROOT = "frontend";
const DEFAULT_DENYLIST_PREFIXES = [".github", "infra", "backend", "server", "api"];

function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeRepoPath(raw: string): string {
  const cleaned = toForwardSlashes(raw.trim());
  const withoutLeading = cleaned.replace(/^\/+/, "").replace(/^\.\//, "");
  return withoutLeading;
}

function normalizePrefix(raw: string): string {
  const normalized = normalizeRepoPath(raw);
  return normalized.replace(/\/+$/, "");
}

function parsePrefixList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => normalizePrefix(entry))
    .filter((entry) => entry.length > 0);
}

function isTraversal(path: string): boolean {
  return path.split("/").some((segment) => segment === "..");
}

function isUnderPrefix(path: string, prefix: string): boolean {
  if (!prefix) return false;
  if (path === prefix) return true;
  return path.startsWith(`${prefix}/`);
}

export function buildGuardConfig(overrides: Partial<GuardConfig> = {}): GuardConfig {
  const frontendRoot = normalizePrefix(
    overrides.frontendRoot ?? process.env.FRONTEND_ROOT ?? DEFAULT_FRONTEND_ROOT
  );

  const allowedFromEnv = parsePrefixList(process.env.FRONTEND_ALLOWED_PREFIXES);
  const denylistFromEnv = parsePrefixList(process.env.FRONTEND_DENYLIST_PREFIXES);

  const allowedPrefixes = (overrides.allowedPrefixes ?? (allowedFromEnv.length > 0 ? allowedFromEnv : [frontendRoot]))
    .map((prefix) => normalizePrefix(prefix))
    .filter((prefix) => prefix.length > 0);

  const denylistPrefixes = (overrides.denylistPrefixes ?? (denylistFromEnv.length > 0 ? denylistFromEnv : DEFAULT_DENYLIST_PREFIXES))
    .map((prefix) => normalizePrefix(prefix))
    .filter((prefix) => prefix.length > 0);

  return {
    frontendRoot,
    allowedPrefixes: allowedPrefixes.length > 0 ? allowedPrefixes : [frontendRoot],
    denylistPrefixes,
  };
}

export function validateEdits(edits: FileEdit[], config: GuardConfig): GuardResult {
  const violations: GuardViolation[] = [];
  const allowedPrefixes = config.allowedPrefixes.map((prefix) => normalizePrefix(prefix));
  const denylistPrefixes = config.denylistPrefixes.map((prefix) => normalizePrefix(prefix));

  for (const edit of edits) {
    const rawPath = edit?.path ?? "";
    const normalizedPath = normalizeRepoPath(rawPath);

    if (!normalizedPath) {
      violations.push({
        code: "PATH_EMPTY",
        path: rawPath,
        message: "Edit path is empty.",
      });
      continue;
    }

    if (isTraversal(normalizedPath)) {
      violations.push({
        code: "PATH_TRAVERSAL",
        path: rawPath,
        message: "Edit path contains a traversal segment (..).",
      });
      continue;
    }

    if (denylistPrefixes.some((prefix) => isUnderPrefix(normalizedPath, prefix))) {
      violations.push({
        code: "PATH_DENYLISTED",
        path: rawPath,
        message: "Edit path is in a denied area.",
      });
    }

    if (!allowedPrefixes.some((prefix) => isUnderPrefix(normalizedPath, prefix))) {
      violations.push({
        code: "PATH_OUTSIDE_FRONTEND",
        path: rawPath,
        message: "Edit path is outside the allowed frontend scope.",
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}

export function formatGuardViolations(violations: GuardViolation[]): string {
  return violations
    .map((violation) => `- ${violation.path || "(empty path)"}: ${violation.message}`)
    .join("\n");
}
