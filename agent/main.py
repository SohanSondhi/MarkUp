"""
MarkUp Python Agent — FastAPI entry point.

Receives the GitLab Duo Planner output from the TypeScript layer,
runs it through Gemini to produce patches, then returns them.

Start with:
    uvicorn agent.main:app --reload --port 8000
"""
import logging
from fastapi import FastAPI, HTTPException
from agent.schemas import IngestionRequest, AgentResponse
from agent.ingestion import ingest_duo_plan
from agent.planner import plan_from_duo_output
from agent.patcher import generate_patches
from agent.validator import validate_patches

logging.basicConfig(level=logging.INFO, format="%(levelname)s  %(name)s  %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="MarkUp Agent", version="1.0.0")


@app.post("/ingest", response_model=AgentResponse)
async def ingest(request: IngestionRequest):
    """
    Main pipeline:
      1. Parse + filter the Duo Planner output (frontend files only)
      2. Ask Gemini to produce a structured patch plan
      3. Ask Gemini to generate the actual file patches (one call per file)
      4. Validate patches against frontend-only guardrails
      5. Return patches to the TypeScript layer
    """
    logger.info(f"Run {request.run_id} — intent: '{request.slack_intent}'")

    try:
        # Step 1: filter Duo plan to frontend files + fetch lean snippets
        ingested = await ingest_duo_plan(
            request.duo_plan_output,
            request.slack_intent,
            request.repo_path,
        )

        # Step 2: Gemini produces a structured plan (what to change per file)
        plan = await plan_from_duo_output(ingested)

        # Step 3: Gemini generates the actual patched file content
        patches = await generate_patches(plan)

        # Step 4: guardrail check — raises ValueError if anything is off
        validated = validate_patches(patches)

        return AgentResponse(
            run_id=request.run_id,
            patches=validated,
            summary=plan.get("summary", ""),
            status="ready_for_commit",
        )

    except ValueError as e:
        # Guardrail violation — return a clear error, not a 500
        logger.error(f"Validation failed: {e}")
        raise HTTPException(status_code=422, detail=str(e))

    except Exception as e:
        logger.error(f"Agent error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health():
    return {"status": "ok", "service": "markup-agent"}
