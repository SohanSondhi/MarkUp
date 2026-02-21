"""
Planner: sends the ingested Duo plan to Gemini and gets back a structured
list of exactly what to change in each file.

Token strategy: we send a summary/snippet per file, not the whole file.
"""
import logging
from agent.gemini import call_gemini

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """
You are a frontend code planning agent for MarkUp.
Given a GitLab Duo issue plan and a Slack request, produce a precise patch plan.

Rules:
- Only plan changes to frontend files (React, Vue, HTML, CSS, Tailwind)
- Never plan backend, API, database, or config changes
- Be specific: name the component or function to change
- Output valid JSON only
"""

TASK_TEMPLATE = """
Slack request: {slack_intent}

Duo issue: {issue_title}
Description: {issue_description}

Files to change:
{files_summary}

Return JSON in this exact shape:
{{
  "summary": "one sentence describing the overall change",
  "patches": [
    {{
      "path": "src/components/Button.tsx",
      "target": "the Button component className prop",
      "change": "update background from blue-500 to indigo-600",
      "change_type": "modify",
      "snippet": "<paste relevant snippet here for the patcher>"
    }}
  ]
}}
"""


async def plan_from_duo_output(ingested: dict) -> dict:
    """
    Calls Gemini once to produce a structured patch plan from the ingested Duo output.
    """
    # Build a lean summary — snippet truncated to 300 chars per file
    files_summary = "\n".join(
        f"- {f['path']}: {f['reason']}\n  snippet: {(f['snippet'] or '')[:300]}"
        for f in ingested["files"]
    )

    task_prompt = TASK_TEMPLATE.format(
        slack_intent=ingested["slack_intent"],
        issue_title=ingested["issue_title"],
        issue_description=ingested["issue_description"],
        files_summary=files_summary,
    )

    logger.info(f"Sending plan prompt to Gemini for {len(ingested['files'])} files")
    plan = await call_gemini(SYSTEM_PROMPT, task_prompt, expect_json=True)
    logger.info(f"Plan received: {plan.get('summary')}")
    return plan
