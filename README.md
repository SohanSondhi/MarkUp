# Markup

## What it does

Markup lets non-technical teams request frontend UI changes via Slack and get a live preview before anything is merged.

```
Slack message
  -> TypeScript ingestion (src/)
  -> GitLab Duo Planner  -- identifies which files to change
  -> Python Agent        -- Gemini reads the Duo plan, generates patches
  -> GitLab API          -- creates branch + commits + Draft MR
  -> Vercel              -- deploys preview URL
  -> Playwright          -- captures before/after screenshots
  -> Slack               -- user approves or requests changes
  -> GitLab MR           -- published for human review
```

---

## Project Structure

```
markup/
+-- src/                          # TypeScript -- Slack bot & GitLab orchestration
|   +-- index.ts                  # entry point
|   +-- config.ts
|   +-- slack/
|   |   +-- app.ts
|   |   +-- handlers.ts           # Slack event handlers
|   |   +-- responses.ts
|   |   +-- updates.ts            # threaded progress messages
|   +-- core/
|   |   +-- orchestrator.ts
|   |   +-- guards.ts             # frontend-only path enforcement
|   |   +-- types.ts
|   |   +-- state.ts
|   |   +-- runStore.ts
|   +-- github/                   # (migrating to GitLab API)
|   |   +-- agent.ts              # calls Python agent via HTTP
|   |   +-- client.ts
|   |   +-- repo.ts
|   |   +-- patch.ts
|   |   +-- pr.ts
|   |   +-- checks.ts
|   +-- utils/
|       +-- diff.ts
|       +-- logger.ts
|
+-- agent/                        # Python -- Gemini AI brain
|   +-- main.py                   # FastAPI app  ->  POST /ingest
|   +-- schemas.py                # Pydantic types (request + response)
|   +-- ingestion.py              # parses GitLab Duo plan, fetches lean snippets
|   +-- planner.py                # Gemini call 1: structured patch plan
|   +-- patcher.py                # Gemini call 2: actual file edits (1 per file)
|   +-- validator.py              # frontend-only guardrails
|   +-- gemini.py                 # Gemini client + key rotation
|   +-- requirements.txt
|
+-- hackathon/
|   +-- MVP_ARCHITECTURE.md
|   +-- architecture.mmd
|   +-- gemini_integration.md
|
+-- .env.example
+-- .gitignore
+-- package.json
+-- tsconfig.json
```

---

## Setup

### TypeScript layer
```bash
npm install
cp .env.example .env
npm run dev
```

### Python agent
```bash
cd agent
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
uvicorn agent.main:app --reload --port 8000
```

---

## How Gemini + GitLab Duo work together

| Step | Who | What |
|------|-----|------|
| 1 | GitLab Duo Planner | Reads the repo, identifies files to touch, creates a structured issue |
| 2 | ingestion.py | Filters to frontend files only, extracts lean snippets |
| 3 | planner.py + Gemini | Reads the Duo plan, decides what to change per file |
| 4 | patcher.py + Gemini | Generates patched file content (one call per file) |
| 5 | validator.py | Blocks any non-frontend or dangerous code |
| 6 | TypeScript + GitLab API | Commits patches, opens Draft MR, triggers Vercel preview |

Duo handles code understanding. Gemini handles code generation. Each Gemini call gets a short, targeted prompt -- never the full repo.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token |
| `SLACK_SIGNING_SECRET` | Slack signing secret |
| `GITLAB_TOKEN` | GitLab personal access token |
| `GITLAB_PROJECT_ID` | GitLab project ID |
| `GEMINI_API_KEY` | Gemini API key |
| `GEMINI_API_KEY_2` / `_3` | Optional rotation keys for rate limits |
| `GEMINI_MODEL` | Model name (default: `gemini-1.5-flash`) |
| `AGENT_BASE_URL` | Python agent URL (default: `http://localhost:8000`) |
| `VERCEL_TOKEN` | Vercel API token |
