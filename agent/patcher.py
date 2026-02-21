"""
Patcher: calls Gemini once per file to generate the updated file content.

One file per call = smaller prompts = fewer token failures.
"""
import difflib
import logging
from agent.gemini import call_gemini
from agent.schemas import FilePatch

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """
You are a frontend code patch generator for MarkUp.
You receive a specific change instruction and the current file content.
Return ONLY the complete updated file — no markdown, no explanation.

Rules:
- Only apply the described change; leave everything else untouched
- Never add backend logic, API calls, or server-side code
- Never hardcode secrets or environment variables
- Return the full file content
"""

TASK_TEMPLATE = """
File: {path}
Target: {target}
Change: {change}

Current content:
```
{snippet}
```

Return the complete updated file content.
"""


async def generate_patches(plan: dict) -> list[FilePatch]:
    """
    Iterates over each patch in the plan and calls Gemini once per file.
    Returns a list of FilePatch objects ready for GitLab commit.
    """
    patches: list[FilePatch] = []

    for item in plan.get("patches", []):
        path    = item["path"]
        snippet = item.get("snippet", "")

        logger.info(f"Generating patch for: {path}")

        task_prompt = TASK_TEMPLATE.format(
            path=path,
            target=item.get("target", ""),
            change=item.get("change", ""),
            snippet=snippet or "File content not available — apply minimal change",
        )

        patched = await call_gemini(SYSTEM_PROMPT, task_prompt, expect_json=False)
        diff    = _diff(snippet, patched, path)

        patches.append(FilePatch(
            path=path,
            original_content=snippet,
            patched_content=patched,
            diff=diff,
            change_type=item.get("change_type", "modify"),
        ))

    logger.info(f"Generated {len(patches)} patch(es)")
    return patches


def _diff(original: str, patched: str, path: str) -> str:
    """Produces a unified diff string for display in Slack."""
    return "".join(difflib.unified_diff(
        original.splitlines(keepends=True),
        patched.splitlines(keepends=True),
        fromfile=f"a/{path}",
        tofile=f"b/{path}",
        lineterm="",
    ))
