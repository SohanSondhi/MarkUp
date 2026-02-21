from pydantic import BaseModel
from typing import List, Optional


# ── What GitLab Duo Planner tells us about a single file ──────────────────────

class DuoPlanFile(BaseModel):
    path: str                       # e.g. "src/components/Button.tsx"
    reason: str                     # why Duo thinks this file needs changing
    snippet: Optional[str] = None   # relevant lines Duo extracted
    change_type: str = "modify"     # "modify" or "create"


# ── The full structured output from GitLab Duo Planner ────────────────────────

class DuoPlanOutput(BaseModel):
    issue_title: str
    issue_description: str
    files: List[DuoPlanFile]
    estimated_scope: str = "small"  # "small" | "medium" | "large"


# ── What the TypeScript layer sends to /ingest ────────────────────────────────

class IngestionRequest(BaseModel):
    run_id: str
    slack_intent: str           # original plain-English message from Slack
    duo_plan_output: DuoPlanOutput
    repo_path: Optional[str] = None  # local clone path (optional)


# ── A single file patch ready for GitLab commit ───────────────────────────────

class FilePatch(BaseModel):
    path: str
    original_content: Optional[str] = None
    patched_content: str
    diff: Optional[str] = None
    change_type: str = "modify"


# ── What the agent returns to the TypeScript layer ────────────────────────────

class AgentResponse(BaseModel):
    run_id: str
    patches: List[FilePatch]
    summary: str
    status: str                 # "ready_for_commit" | "error"
    error: Optional[str] = None
