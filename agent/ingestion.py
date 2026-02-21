"""
Ingestion layer: reads the GitLab Duo Planner output and builds a
lean, token-efficient context for Gemini.

Key idea: Duo already identified which files and why.
We fetch only relevant snippets — never the full repo.
"""
import os
import logging
from typing import Optional
from agent.schemas import DuoPlanOutput

logger = logging.getLogger(__name__)

# Only these prefixes are allowed through to Gemini
ALLOWED_PREFIXES = [
    "src/components", "src/pages", "src/styles", "src/layouts",
    "src/ui", "src/hooks", "public/", "assets/", "styles/",
    "components/", "pages/",
]

# These are always blocked, even if Duo Planner suggests them
BLOCKED_PREFIXES = [
    "src/api", "src/server", "src/db", "src/backend",
    "migrations/", "server/", "backend/", "config/", "secrets/",
    ".env", "Dockerfile", "docker-compose", "kubernetes/", "terraform/",
]

MAX_SNIPPET_LINES = 200  # files larger than this get trimmed


def _is_frontend(path: str) -> bool:
    """Returns True only if the file path is safe for frontend editing."""
    p = path.lower()
    if any(p.startswith(b.lower()) for b in BLOCKED_PREFIXES):
        logger.warning(f"Blocked non-frontend file: {path}")
        return False
    if any(p.startswith(a.lower()) for a in ALLOWED_PREFIXES):
        return True
    # Allow common frontend extensions at the root level
    return p.endswith((".tsx", ".ts", ".jsx", ".js", ".css", ".scss", ".html", ".vue", ".svelte"))


def _read_snippet(path: str, repo_path: Optional[str], fallback: Optional[str]) -> Optional[str]:
    """Read the file from disk; trim large files to save tokens."""
    if not repo_path:
        return fallback

    full_path = os.path.join(repo_path, path)
    if not os.path.exists(full_path):
        return fallback

    with open(full_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    if len(lines) <= MAX_SNIPPET_LINES:
        return "".join(lines)

    # Large file: keep first 100 + last 30 lines
    trimmed = "".join(lines[:100])
    trimmed += f"\n// ... [{len(lines) - 130} lines trimmed] ...\n\n"
    trimmed += "".join(lines[-30:])
    return trimmed


async def ingest_duo_plan(duo_plan: DuoPlanOutput, slack_intent: str, repo_path: Optional[str] = None) -> dict:
    """
    Filters and enriches the Duo Planner output.
    Returns a clean dict ready for the Gemini planner.
    """
    logger.info(f"Ingesting Duo plan: '{duo_plan.issue_title}' ({len(duo_plan.files)} files)")

    allowed, blocked = [], []

    for file in duo_plan.files:
        if _is_frontend(file.path):
            allowed.append({
                "path":        file.path,
                "reason":      file.reason,
                "snippet":     _read_snippet(file.path, repo_path, file.snippet),
                "change_type": file.change_type,
            })
        else:
            blocked.append(file.path)

    if blocked:
        logger.warning(f"Skipped {len(blocked)} non-frontend files: {blocked}")

    return {
        "slack_intent":       slack_intent,
        "issue_title":        duo_plan.issue_title,
        "issue_description":  duo_plan.issue_description,
        "estimated_scope":    duo_plan.estimated_scope,
        "files":              allowed,
        "blocked_files":      blocked,
    }
