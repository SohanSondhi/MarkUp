# Markup MVP — Architecture, Agent Strategy & Implementation Plan

> **Goal:** Let non-technical users request frontend UI changes via Slack, preview them in a live deployment, and merge frontend-only MRs through GitLab — all orchestrated by a GitLab Duo agent.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [GitLab Duo Agent Prompting](#2-gitlab-duo-agent-prompting)
3. [Module Responsibilities](#3-module-responsibilities)
4. [CI/CD Workflow (preview.yml)](#4-cicd-workflow-previewyml)
5. [Slack & UI Interaction Design](#5-slack--ui-interaction-design)
6. [Prioritized Task List](#6-prioritized-task-list)
7. [Example Code Snippets](#7-example-code-snippets)

---

## 1. System Architecture

### 1.1 Component Overview

| Layer | Tech | Role |
|---|---|---|
| **Slack Ingestion** | TypeScript / Bolt | Receive `@markup` mentions, manage run state machine, present previews & collect approvals |
| **GitLab Duo Agent** | GitLab Duo API | Intent parsing, file targeting, patch generation, constraint validation, coordinate code changes on branches, trigger CI/CD, report status |
| **CI/CD Pipeline** | `.gitlab-ci.yml` | Build frontend, deploy preview (Vercel / GitLab Pages), run Playwright screenshots |
| **Playwright** | Node-based test runner | Capture before/after screenshots from the preview URL |
| **GitLab** | Merge Requests API | Create frontend-only MRs from approved patches |

### 1.2 High-Level Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          SLACK WORKSPACE                                │
│                                                                         │
│  User: "@markup add a testimonials section below the hero on /pricing"  │
│        │                                                                │
│        ▼                                                                │
│  ┌──────────────┐                                                       │
│  │  Markup Bot   │◄──── Approval / Refinement buttons ◄── User          │
│  └──────┬───────┘                                                       │
└─────────┼───────────────────────────────────────────────────────────────┘
          │
          ▼
┌──────────────────────────────────────┐
│  TYPESCRIPT LAYER (src/)             │
│                                      │
│  slack/handlers.ts  ─► RunStore      │
│        │                (state FSM)  │
│        │                             │
│        ├──► HTTP POST /plan ─────────┼──┐
│        │                             │  │
│        ├──► HTTP POST /patch ────────┼──┤
│        │                             │  │
│        └──► core/orchestrator.ts     │  │
│              (guardrail validation)  │  │
└──────────────────────────────────────┘  │
                                          ▼
                              ┌──────────────────────────┐
                              │  GITLAB DUO AGENT FLOW   │
                              │                          │
                              │  1. Parse UI intent      │
                              │  2. Plan frontend edits  │
                              │  3. Generate code changes│
                              │  4. Create branch+commit │
                              │  5. Trigger CI pipeline  │
                              │  6. Report status + URLs │
                              └──────────┬───────────────┘
                                         │
                              ┌──────────▼───────────────┐
                              │  GITLAB CI/CD PIPELINE   │
                              │  (.gitlab-ci.yml)        │
                              │                          │
                              │  build ► deploy ► test   │
                              │                          │
                              │  • Build frontend        │
                              │  • Deploy to Vercel /    │
                              │    GitLab Pages          │
                              │  • Playwright captures   │
                              │    before/after shots    │
                              │  • Expose artifacts      │
                              └──────────┬───────────────┘
                                         │
                                         ▼
                              ┌──────────────────────────┐
                              │  GITLAB MERGE REQUEST     │
                              │  (frontend-only)          │
                              │                          │
                              │  • Scoped diff            │
                              │  • Preview URL            │
                              │  • Screenshot artifacts   │
                              └──────────────────────────┘
```

### 1.3 Data Flow Sequence

```
User ──@mention──► Slack Bot
                     │
                     ├─1─► RunStore.createRun(PLANNING)
                     │
                     ├─2─► Duo Agent /plan
                     │       { request, repoFiles, fileContents }
                     │     ◄── { summary, targetPaths, targetUrlPath,
                     │           openQuestions, risks, confidence }
                     │
                     ├─3─► If openQuestions → ask user, loop back
                     │
                     ├─4─► Present plan to user (Approve / Revise)
                     │     ◄── User clicks Approve
                     │
                     ├─5─► Duo Agent /patch
                     │       { request, plan, fileContents }
                     │     ◄── { summary, edits: [{ path, content }] }
                     │
                     ├─6─► core/orchestrator.validateFrontendEdits(edits)
                     │
                     ├─7─► GitLab Duo: create branch, commit edits
                     │     → CI/CD triggers automatically
                     │
                     ├─8─► Poll for preview URL + screenshots
                     │     ◄── { previewUrl, screenshots[] }
                     │
                     ├─9─► Post preview + side-by-side screenshots to Slack
                     │     ◄── User: Approve / Refine
                     │
                     ├─10► If Refine → loop to step 2 with updated intent
                     │
                     └─11► If Approve → GitLab: create MR, notify user
```

---

## 2. GitLab Duo Agent Prompting

### 2.1 System Prompt (YAML)

```yaml
duo_agent:
  system_prompt: |
    You are a GitLab Duo coding agent specialized in frontend-only edits.

    ROLE:
    - You parse user interface change requests written in plain English.
    - You determine which frontend source files need modification.
    - You generate minimal, safe code changes.
    - You NEVER touch backend logic, API routes, server configs, CI configs,
      environment variables, database schemas, or infrastructure files.

    CONSTRAINTS:
    - Only edit files under the designated frontend root (e.g., "frontend/",
      "apps/web/", "src/app/", or as configured).
    - Never create new files. Only modify existing ones.
    - Never delete files.
    - Never modify: package.json, package-lock.json, yarn.lock, tsconfig.json,
      next.config.*, vite.config.*, tailwind.config.*, .env*, Dockerfile,
      docker-compose.*, .gitlab-ci.yml, .github/**.
    - Edits must be limited to: .tsx, .ts, .jsx, .js, .css, .scss, .html, .svg.
    - Maximum 5 files per change request.
    - Maximum 200 lines changed per file.
    - Do not introduce new npm dependencies.
    - Do not modify authentication, authorization, or security logic.
    - Do not modify API calls, data fetching, or server-side rendering logic.

    OUTPUT FORMAT:
    - Always return strict JSON (no markdown fences, no commentary).
    - Follow the exact schema provided in each task prompt.

    GUARDRAILS:
    - If the request is ambiguous, return openQuestions instead of guessing.
    - If the request requires backend changes, return an error with
      reason: "backend_required".
    - If the request would break existing layout significantly,
      flag it in risks[].
    - Confidence score must honestly reflect your certainty (0.0–1.0).

  model_preferences:
    # GitLab Duo agent handles all LLM reasoning internally.
    # No explicit model selection required.
```

### 2.2 Task Prompt: Planning

```yaml
duo_task_plan:
  prompt: |
    Given the following user request and repository file list, produce a plan
    for frontend-only edits.

    USER REQUEST:
    {request}

    AVAILABLE FILES:
    {file_list}

    SELECTED FILE CONTENTS:
    {file_contents}

    Return JSON matching this schema:
    {
      "summary": "1-2 sentence plan description",
      "targetPaths": ["frontend/path/to/file.tsx"],
      "targetUrlPath": "/page-url",
      "openQuestions": ["non-technical clarifying question"],
      "risks": ["potential visual/UX risk"],
      "confidence": 0.85
    }

    RULES:
    - targetPaths must only contain files from the AVAILABLE FILES list.
    - openQuestions must be non-technical (about visual placement, copy, style).
    - Do NOT mention file paths, component names, or code in openQuestions.
    - If confidence < 0.4, you MUST include at least one openQuestion.
```

### 2.3 Task Prompt: Patch Generation

```yaml
duo_task_patch:
  prompt: |
    Generate frontend code edits based on the approved plan.

    USER REQUEST:
    {request}

    PLAN:
    {plan_json}

    FILE CONTENTS (full source of each target file):
    {file_contents}

    Return JSON matching this schema:
    {
      "summary": "short description of changes",
      "edits": [
        {
          "path": "frontend/components/Hero.tsx",
          "content": "FULL FILE CONTENT with changes applied"
        }
      ]
    }

    RULES:
    - Each edit.content must be the COMPLETE file contents (not a diff).
    - Only modify files whose full contents were provided above.
    - Preserve all existing imports, exports, and component structure.
    - Do not add new dependencies or imports from packages not already used.
    - Maintain existing code style (indentation, quotes, semicolons).
    - If the plan mentions a specific URL path, ensure the edit targets the
      component rendered at that route.
```

### 2.4 Task Prompt: CI/CD Trigger

```yaml
duo_task_ci:
  prompt: |
    After committing code changes to branch "{branch_name}":
    1. The GitLab CI pipeline (.gitlab-ci.yml) will trigger automatically.
    2. Monitor the pipeline for the "deploy_preview" job.
    3. Once deployed, extract the preview URL from the job artifacts or
       environment URL.
    4. Monitor the "playwright_screenshots" job.
    5. Extract screenshot artifact URLs.
    6. Report back:
    {
      "pipeline_status": "success|failed|running",
      "preview_url": "https://preview-{branch}.vercel.app",
      "screenshots": {
        "before": "https://gitlab.com/.../before.png",
        "after": "https://gitlab.com/.../after.png"
      },
      "ci_errors": []
    }
```

### 2.5 Guardrail Enforcement Matrix

| Check | Enforcement Point | Action on Violation |
|---|---|---|
| Path outside frontend root | Python `validators.py` + TS `guards.ts` | Block edit, return error |
| Path traversal (`..`) | TS `guards.ts` | Block edit, return error |
| Denylisted directory | TS `guards.ts` | Block edit, return error |
| New file creation | TS `agent.ts` | Block edit, return error |
| Config file modification | Python `validators.py` | Block edit, return error |
| > 5 files changed | Python `validators.py` | Block edit, ask user to narrow scope |
| > 200 lines per file | Python `validators.py` | Warn, allow with flag |
| Backend logic detected | Duo system prompt + TS guards | Return `reason: "backend_required"` |
| Low confidence (< 0.4) | Duo system prompt | Force `openQuestions`, do not auto-proceed |

---

## 3. Module Responsibilities

### 3.1 TypeScript Layer (`src/`)

#### `slack/app.ts` — Bolt Application Setup
- Initialize Slack Bolt app in socket mode
- Register all event handlers, action handlers, and message handlers
- **No changes needed** — existing implementation is solid

#### `slack/handlers.ts` — Event Router & State Machine Driver
- **`app_mention` event**: Receive initial request, create run, dispatch to Python agent
- **`markup_approve_plan` action**: On plan approval, call Python agent `/patch`, then push to GitLab
- **`markup_revise_plan` action**: Prompt for refinement, loop back to `/plan`
- **`markup_approve_preview` action** (NEW): On preview approval, create the final MR
- **`markup_refine_preview` action** (NEW): On preview rejection, loop back with updated intent
- Manage thread-based conversation state via `runStore`
- Handle timeouts (3-minute limit per phase)

#### `slack/updates.ts` — Message Builders (NEW)
- `buildPlanMessage(plan, runId)` — Block Kit message with plan summary + Approve/Revise buttons
- `buildPreviewMessage(previewUrl, screenshots, runId)` — Block Kit with preview link, before/after images, Approve/Refine buttons
- `buildMrCreatedMessage(mrUrl, summary)` — Final confirmation message
- `buildErrorMessage(error)` — Error display with retry suggestion

#### `slack/responses.ts` — Static Response Templates
- Existing: help text, working-on-it message
- Add: "analyzing…", "deploying preview…", "capturing screenshots…", "MR created"

#### `core/runStore.ts` — In-Memory State Machine
- Add new statuses: `DEPLOYING_PREVIEW`, `AWAITING_PREVIEW_APPROVAL`
- Store: `previewUrl`, `screenshotUrls`, `mrUrl`, `mrNumber`, `branchName`
- **Existing implementation works**; extend `RunRecord` type

#### `core/orchestrator.ts` — Guardrail Validation
- **Existing**: `validateFrontendEdits()`, `assertFrontendEdits()`
- **No changes needed** — already validates path constraints, traversal, denylist

#### `core/guards.ts` — Guard Logic
- **Existing**: Path normalization, prefix matching, denylist checks
- **No changes needed** — already comprehensive

#### `core/types.ts` — Shared Types
- **Existing**: `FileEdit`, `GuardConfig`, `GuardViolation`, `GuardResult`
- Add: `PreviewResult`, `ScreenshotPair`

#### `core/state.ts` — Run Context
- **Existing**: `RunStep` enum, `RunContext` type
- Add steps: `DEPLOY_PREVIEW`, `SCREENSHOT`, `AWAITING_PREVIEW_APPROVAL`

#### `github/` → `gitlab/` (Migration)
- Rename module to `gitlab/` (or keep as `github/` with GitLab adapter)
- `client.ts` — GitLab API client (replace Octokit with `@gitbeaker/rest`)
- `repo.ts` — List files, get content, search files via GitLab API
- `pr.ts` → `mr.ts` — Create merge requests instead of PRs
- `checks.ts` — Poll GitLab pipeline status + environment URLs
- `agent.ts` — Orchestrate plan → patch → commit → MR flow

#### ~~`gemini/client.ts`~~ — REMOVED
- Gemini API client has been removed; all LLM reasoning is now handled by GitLab Duo agent.
- The TypeScript layer communicates with the Duo agent via HTTP (`DUO_AGENT_URL`).

#### `utils/diff.ts` — Diff Utilities (NEW)
- Generate human-readable diffs for Slack display
- Compute line-count deltas for guardrail checks

#### `utils/logger.ts` — Structured Logging (NEW)
- Pino or Winston logger with run context
- Log levels: debug, info, warn, error

#### New: `agent/bridge.ts` — GitLab Duo Agent HTTP Client
- `callDuoAgent(endpoint, body)` — Generic HTTP caller with timeout
- `duoPlan(request, files)` → `POST {DUO_AGENT_URL}/plan`
- `duoPatch(request, plan, files)` → `POST {DUO_AGENT_URL}/patch`
- Timeout handling, retry, error mapping
- Replaces the previous `callAgentPlan` / `callAgentPatch` functions that targeted a Python FastAPI backend

### ~~3.2 Python Agent Layer (`agent/`)~~ — REMOVED

The Python agent layer (FastAPI + Gemini SDK) has been removed. All LLM-powered
intent classification, planning, and patch generation is now handled by the
**GitLab Duo agent**, which the TypeScript orchestration layer calls via HTTP.

The Duo agent exposes the same logical contract:
- `/plan` — Parse intent, select target files, return a structured plan
- `/patch` — Generate frontend-only code edits based on an approved plan

Constraint validation remains in the TypeScript layer (`core/guards.ts`,
`core/orchestrator.ts`).

---

## 4. CI/CD Workflow (preview.yml)

### 4.1 GitLab CI Configuration

```yaml
# .gitlab-ci.yml

stages:
  - build
  - deploy_preview
  - screenshot
  - report

variables:
  FRONTEND_DIR: "frontend"
  NODE_VERSION: "20"
  PREVIEW_BASE_URL: ""  # Set by deploy job

# ─── Only run on markup/* branches ───────────────────────────
workflow:
  rules:
    - if: '$CI_COMMIT_BRANCH =~ /^markup\//'
      when: always
    - when: never

# ─── Build ───────────────────────────────────────────────────
build_frontend:
  stage: build
  image: node:${NODE_VERSION}
  script:
    - cd ${FRONTEND_DIR}
    - npm ci
    - npm run build
  artifacts:
    paths:
      - ${FRONTEND_DIR}/dist/
      - ${FRONTEND_DIR}/.next/
      - ${FRONTEND_DIR}/build/
    expire_in: 1 hour
  cache:
    key: "${CI_COMMIT_REF_SLUG}-node"
    paths:
      - ${FRONTEND_DIR}/node_modules/

# ─── Deploy Preview ─────────────────────────────────────────
deploy_preview:
  stage: deploy_preview
  image: node:${NODE_VERSION}
  dependencies:
    - build_frontend
  environment:
    name: preview/${CI_COMMIT_REF_SLUG}
    url: https://${CI_COMMIT_REF_SLUG}.preview.example.com
    on_stop: stop_preview
  script:
    # Option A: Vercel
    - npm i -g vercel
    - |
      PREVIEW_URL=$(vercel deploy \
        --token $VERCEL_TOKEN \
        --yes \
        --cwd ${FRONTEND_DIR} \
        2>&1 | grep -oP 'https://[^\s]+\.vercel\.app')
    - echo "PREVIEW_URL=${PREVIEW_URL}" >> deploy.env
    - echo "Preview deployed at ${PREVIEW_URL}"
  artifacts:
    reports:
      dotenv: deploy.env
    paths:
      - deploy.env
    expire_in: 1 hour

stop_preview:
  stage: deploy_preview
  when: manual
  environment:
    name: preview/${CI_COMMIT_REF_SLUG}
    action: stop
  script:
    - echo "Preview environment stopped"

# ─── Playwright Screenshots ─────────────────────────────────
capture_screenshots:
  stage: screenshot
  image: mcr.microsoft.com/playwright:v1.49.0-noble
  dependencies:
    - deploy_preview
  variables:
    PREVIEW_URL: "${PREVIEW_URL}"
  script:
    # Capture "before" from production/main
    - npx playwright test screenshots/capture.spec.ts
      --project=chromium
      --reporter=list
    - mkdir -p screenshots/output
    - |
      echo '{
        "preview_url": "'${PREVIEW_URL}'",
        "before": "screenshots/output/before.png",
        "after": "screenshots/output/after.png",
        "diff": "screenshots/output/diff.png"
      }' > screenshots/output/manifest.json
  artifacts:
    paths:
      - screenshots/output/
    expire_in: 7 days
    when: always

# ─── Report Back ─────────────────────────────────────────────
report_status:
  stage: report
  image: curlimages/curl:latest
  dependencies:
    - deploy_preview
    - capture_screenshots
  script:
    - |
      curl -X POST "${MARKUP_WEBHOOK_URL}/pipeline-complete" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${MARKUP_WEBHOOK_SECRET}" \
        -d '{
          "branch": "'${CI_COMMIT_BRANCH}'",
          "pipeline_id": '${CI_PIPELINE_ID}',
          "pipeline_status": "'${CI_JOB_STATUS}'",
          "preview_url": "'${PREVIEW_URL}'",
          "screenshot_artifacts": "'${CI_PROJECT_URL}'/-/jobs/'${CI_JOB_ID}'/artifacts/browse/screenshots/output/",
          "mr_iid": "'${CI_MERGE_REQUEST_IID}'"
        }'
  when: always
```

### 4.2 Playwright Screenshot Script

```typescript
// screenshots/capture.spec.ts
import { test, expect } from "@playwright/test";

const PREVIEW_URL = process.env.PREVIEW_URL!;
const PRODUCTION_URL = process.env.PRODUCTION_URL || "https://www.example.com";
const TARGET_PATH = process.env.TARGET_PATH || "/";

test("capture before/after screenshots", async ({ page }) => {
  // Before: production site
  await page.goto(`${PRODUCTION_URL}${TARGET_PATH}`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: "screenshots/output/before.png",
    fullPage: true,
  });

  // After: preview deployment
  await page.goto(`${PREVIEW_URL}${TARGET_PATH}`, {
    waitUntil: "networkidle",
  });
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: "screenshots/output/after.png",
    fullPage: true,
  });
});
```

### 4.3 How Duo Triggers the Pipeline

1. **GitLab Duo creates a branch** named `markup/{runId}` and commits the generated edits.
2. **The `workflow.rules`** in `.gitlab-ci.yml` match branches prefixed with `markup/` and auto-trigger the pipeline.
3. **The `report_status` job** sends a webhook back to the TypeScript layer with the preview URL and screenshot artifact links.
4. **The TypeScript layer** receives the webhook, updates `RunStore`, and posts the preview to Slack.

---

## 5. Slack & UI Interaction Design

### 5.1 Message Flow

#### Step 1: Change Request Received

```
┌─────────────────────────────────────────────────┐
│ 🔄 Working on it (job a1b2c3)                   │
│                                                  │
│ Request: "Add a testimonials carousel below the  │
│ hero section on the pricing page"                │
│                                                  │
│ Analyzing the request and selecting files...     │
└─────────────────────────────────────────────────┘
```

- Posted as a thread reply to the user's `@markup` mention
- Uses plain text (no buttons yet)

#### Step 2: Plan Ready (or Clarification Needed)

**If clarification needed:**
```
┌─────────────────────────────────────────────────┐
│ I have a couple questions before I proceed:      │
│                                                  │
│ • Should the testimonials show customer photos?  │
│ • How many testimonials should be visible at     │
│   once — 1, 2, or 3?                            │
│                                                  │
│ Reply in this thread and mention me.             │
└─────────────────────────────────────────────────┘
```

**If plan is ready:**
```
┌─────────────────────────────────────────────────┐
│ *Plan Summary*                                   │
│                                                  │
│ Summary: Add a testimonials carousel component   │
│ below the hero section on the pricing page.      │
│ Three cards with name, quote, and photo.         │
│                                                  │
│ Target URL: /pricing                             │
│                                                  │
│ Risks: Visual overlap with existing CTA section  │
│                                                  │
│ ┌─────────────┐  ┌─────────────┐                │
│ │ Approve Plan │  │ Revise Plan  │                │
│ └─────────────┘  └─────────────┘                │
└─────────────────────────────────────────────────┘
```

- Uses **Block Kit** with `section` + `actions` blocks
- `Approve Plan` button → triggers patch generation
- `Revise Plan` button → prompts for typed revision

#### Step 3: Preview Deployed

```
┌─────────────────────────────────────────────────┐
│ ✅ Preview deployed!                             │
│                                                  │
│ 🔗 Preview: https://markup-a1b2c3.vercel.app    │
│    /pricing                                      │
│                                                  │
│ *Before*              *After*                    │
│ ┌──────────────┐  ┌──────────────┐              │
│ │  [screenshot] │  │  [screenshot] │              │
│ └──────────────┘  └──────────────┘              │
│                                                  │
│ ┌──────────────────┐  ┌───────────────┐         │
│ │ Approve & Merge   │  │ Request Changes│         │
│ └──────────────────┘  └───────────────┘         │
└─────────────────────────────────────────────────┘
```

- Uses **Block Kit** with `image` blocks for screenshots
- Screenshots hosted as GitLab CI artifacts (publicly accessible URLs)
- `Approve & Merge` → creates the final GitLab MR
- `Request Changes` → prompts for typed refinement, loops back

#### Step 4: Refinement Prompt

```
┌─────────────────────────────────────────────────┐
│ Got it. Reply in this thread with your changes   │
│ and mention me. For example:                     │
│                                                  │
│ "@markup make the testimonial cards wider and    │
│ use a blue background instead of white"          │
└─────────────────────────────────────────────────┘
```

#### Step 5: Merge Request Created

```
┌─────────────────────────────────────────────────┐
│ 🎉 Merge request created!                        │
│                                                  │
│ 🔗 MR: https://gitlab.com/org/repo/-/merge_     │
│    requests/142                                  │
│                                                  │
│ Summary: Added testimonials carousel below hero  │
│ on pricing page with 3 customer cards.           │
│                                                  │
│ The MR is ready for code review and merge.       │
└─────────────────────────────────────────────────┘
```

### 5.2 Interaction Patterns

| Element | Usage |
|---|---|
| **Buttons** | Approve Plan, Revise Plan, Approve & Merge, Request Changes |
| **Thread replies** | All conversation in a single thread per request |
| **Image blocks** | Before/after screenshot display |
| **Modals** | Not used in MVP (simplicity); consider for v2 multi-field refinements |
| **Ephemeral messages** | Not used (all participants should see status) |

### 5.3 Where Screenshots & Links Are Sent

- **All messages**: Posted as thread replies to the original `@markup` mention
- **Screenshots**: Hosted as GitLab CI artifacts; referenced by URL in Slack `image` blocks
- **Preview link**: Inline in the thread as a clickable URL
- **MR link**: Inline in the final confirmation message

---

## 6. Prioritized Task List

### Phase 1: Foundation (Week 1) — ~3 days

| # | Task | Est. | Dependencies | Notes |
|---|---|---|---|---|
| 1.1 | Define Duo system & task prompts (plan, patch, CI) | 4h | — | YAML config; iterate on wording |
| 1.2 | Configure GitLab Duo agent service | 4h | 1.1 | Deploy Duo agent, expose /plan and /patch endpoints |
| 1.3 | Test Duo agent /plan + /patch contract | 3h | 1.2 | Verify JSON schema compliance with TS types |

### Phase 2: Bridge & Integration (Week 1–2) — ~3 days

| # | Task | Est. | Dependencies | Notes |
|---|---|---|---|---|
| 2.1 | Integrate Duo agent HTTP calls in `github/agent.ts` | 4h | 1.2 | `duoPlan`, `duoPatch` via `DUO_AGENT_URL` (already scaffolded) |
| 2.2 | Update `slack/handlers.ts` — route through Duo agent | 4h | 2.1 | Imports already updated; test full flow |
| 2.3 | Migrate `github/` → `gitlab/` module | 6h | — | Replace Octokit with `@gitbeaker/rest`; adapt MR creation |
| 2.4 | Update `core/runStore.ts` — add new states | 2h | — | DEPLOYING_PREVIEW, AWAITING_PREVIEW_APPROVAL |
| 2.5 | Implement `slack/updates.ts` — Block Kit builders | 4h | — | Plan, preview, MR messages with buttons and images |

### Phase 3: CI/CD & Preview (Week 2) — ~3 days

| # | Task | Est. | Dependencies | Notes |
|---|---|---|---|---|
| 3.1 | Write `.gitlab-ci.yml` preview pipeline | 4h | 2.3 | Build, deploy, screenshot, report stages |
| 3.2 | Configure Vercel (or GitLab Pages) preview deployment | 3h | 3.1 | Vercel CLI or GitLab pages; auto-deploy on `markup/*` branches |
| 3.3 | Write Playwright screenshot capture script | 4h | 3.2 | Before (production) + after (preview); full-page captures |
| 3.4 | Implement webhook receiver in TS for pipeline results | 4h | 3.1, 2.2 | `POST /pipeline-complete` → update RunStore → notify Slack |
| 3.5 | Wire screenshot artifacts into Slack preview message | 3h | 3.3, 2.5 | Image blocks with artifact URLs |

### Phase 4: Confirmation Flow (Week 2–3) — ~2 days

| # | Task | Est. | Dependencies | Notes |
|---|---|---|---|---|
| 4.1 | Implement preview approval action handler | 3h | 3.4, 2.5 | `markup_approve_preview` → create MR |
| 4.2 | Implement preview refinement loop | 4h | 4.1, 2.2 | `markup_refine_preview` → updated intent → re-plan → re-patch |
| 4.3 | Final MR creation + notification | 3h | 4.1, 2.3 | GitLab MR API call + Slack confirmation |
| 4.4 | End-to-end integration test | 4h | All | Slack → agent → GitLab → preview → approve → MR |

### Phase 5: Polish (Week 3) — ~2 days

| # | Task | Est. | Dependencies | Notes |
|---|---|---|---|---|
| 5.1 | Error handling & timeout resilience | 4h | All | Graceful failures at each stage |
| 5.2 | Logging (structured, per-run context) | 3h | All | Pino logger with runId correlation |
| 5.3 | Documentation & README update | 3h | All | Setup, env vars, architecture diagram |
| 5.4 | Demo script dry run | 2h | All | Walk through hackathon demo flow |

### Dependency Graph

```
1.1 ──────────────────────────────────────────►
1.1 ──► 1.2 ──► 1.3
                 │
              2.1 ──► 2.2 ──► 3.4 ──► 4.1 ──► 4.3
                       │              │
              2.3 ──► 3.1 ──► 3.2   4.2
                       │       │
              2.4      3.3 ──► 3.5
              2.5 ─────────────────► 4.1
```

### Total Estimated Effort: ~63 hours (~8 working days)

---

## 7. Example Code Snippets

### 7.1 TypeScript → GitLab Duo Agent Bridge

The Duo agent HTTP client is now integrated directly into `github/agent.ts`.
No separate bridge file is needed.

```typescript
// Excerpt from src/github/agent.ts — Duo agent HTTP client

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
```

### 7.2 Duo Agent — Expected Request/Response Contracts

The GitLab Duo agent must expose two endpoints matching these contracts:

**POST /plan**
```json
// Request
{
  "request": "Add a testimonials section below the hero on /pricing",
  "frontendRoot": "frontend",
  "availableFiles": ["frontend/app/pricing/page.tsx", "..."],
  "fileContents": [
    { "path": "frontend/app/pricing/page.tsx", "content": "..." }
  ]
}

// Response
{
  "summary": "Add testimonials carousel below hero on pricing page",
  "targetPaths": ["frontend/app/pricing/page.tsx"],
  "targetUrlPath": "/pricing",
  "openQuestions": [],
  "risks": ["Visual overlap with existing CTA section"],
  "confidence": 0.85
}
```

**POST /patch**
```json
// Request
{
  "request": "Add a testimonials section below the hero on /pricing",
  "frontendRoot": "frontend",
  "availableFiles": ["frontend/app/pricing/page.tsx", "..."],
  "fileContents": [
    { "path": "frontend/app/pricing/page.tsx", "content": "..." }
  ],
  "plan": { "summary": "...", "targetPaths": ["..."], "..." : "..." },
  "forceEdit": false
}

// Response
{
  "summary": "Added 3-card testimonials carousel below hero",
  "edits": [
    {
      "path": "frontend/app/pricing/page.tsx",
      "content": "// FULL FILE CONTENT with changes applied..."
    }
  ]
}
```

### 7.3 Playwright Screenshot Capture

```typescript
// screenshots/capture.spec.ts

import { test } from "@playwright/test";

const PREVIEW_URL = process.env.PREVIEW_URL!;
const PRODUCTION_URL = process.env.PRODUCTION_URL ?? "https://www.example.com";
const TARGET_PATH = process.env.TARGET_PATH ?? "/";
const VIEWPORT = { width: 1440, height: 900 };

test.describe("Markup Visual Capture", () => {
  test.use({ viewport: VIEWPORT });

  test("capture before screenshot (production)", async ({ page }) => {
    await page.goto(`${PRODUCTION_URL}${TARGET_PATH}`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    // Wait for lazy-loaded content
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: "screenshots/output/before.png",
      fullPage: true,
    });
  });

  test("capture after screenshot (preview)", async ({ page }) => {
    if (!PREVIEW_URL) {
      test.skip();
      return;
    }

    await page.goto(`${PREVIEW_URL}${TARGET_PATH}`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    await page.waitForTimeout(2000);

    await page.screenshot({
      path: "screenshots/output/after.png",
      fullPage: true,
    });
  });
});
```

```typescript
// screenshots/playwright.config.ts

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "./output",
  use: {
    headless: true,
    screenshot: "off",
    trace: "off",
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  retries: 1,
  timeout: 60_000,
});
```

### 7.4 GitLab Duo Agent Flow Trigger (from TypeScript)

```typescript
// src/gitlab/duo.ts

type DuoAgentResponse = {
  branch_name: string;
  commit_sha: string;
  pipeline_id: number;
  status: "triggered" | "error";
  error?: string;
};

const GITLAB_API_URL = process.env.GITLAB_API_URL ?? "https://gitlab.com/api/v4";
const GITLAB_TOKEN = process.env.GITLAB_TOKEN!;
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID!;

export async function triggerDuoAgentFlow(args: {
  runId: string;
  request: string;
  edits: { path: string; content: string }[];
  baseBranch: string;
}): Promise<DuoAgentResponse> {
  const { runId, request, edits, baseBranch } = args;
  const branchName = `markup/${runId}`;

  // 1. Create branch from base
  await fetch(`${GITLAB_API_URL}/projects/${GITLAB_PROJECT_ID}/repository/branches`, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": GITLAB_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      branch: branchName,
      ref: baseBranch,
    }),
  });

  // 2. Commit edits to the branch
  const actions = edits.map((edit) => ({
    action: "update" as const,
    file_path: edit.path,
    content: edit.content,
  }));

  const commitResponse = await fetch(
    `${GITLAB_API_URL}/projects/${GITLAB_PROJECT_ID}/repository/commits`,
    {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": GITLAB_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        branch: branchName,
        commit_message: `markup: ${request.slice(0, 72)}`,
        actions,
      }),
    },
  );

  if (!commitResponse.ok) {
    const errorText = await commitResponse.text();
    return { branch_name: branchName, commit_sha: "", pipeline_id: 0, status: "error", error: errorText };
  }

  const commitData = await commitResponse.json();

  // 3. Pipeline auto-triggers from CI rules — fetch pipeline ID
  const pipelinesResponse = await fetch(
    `${GITLAB_API_URL}/projects/${GITLAB_PROJECT_ID}/pipelines?ref=${branchName}&per_page=1`,
    { headers: { "PRIVATE-TOKEN": GITLAB_TOKEN } },
  );
  const pipelines = await pipelinesResponse.json();
  const pipelineId = pipelines?.[0]?.id ?? 0;

  return {
    branch_name: branchName,
    commit_sha: commitData.id,
    pipeline_id: pipelineId,
    status: "triggered",
  };
}

export async function pollPipelineStatus(pipelineId: number): Promise<{
  status: string;
  preview_url: string | null;
}> {
  const response = await fetch(
    `${GITLAB_API_URL}/projects/${GITLAB_PROJECT_ID}/pipelines/${pipelineId}`,
    { headers: { "PRIVATE-TOKEN": GITLAB_TOKEN } },
  );
  const data = await response.json();

  // Check for environment/deployment URL
  let previewUrl: string | null = null;
  if (data.status === "success") {
    const envResponse = await fetch(
      `${GITLAB_API_URL}/projects/${GITLAB_PROJECT_ID}/pipelines/${pipelineId}/jobs`,
      { headers: { "PRIVATE-TOKEN": GITLAB_TOKEN } },
    );
    const jobs = await envResponse.json();
    for (const job of jobs) {
      if (job.name === "deploy_preview" && job.environment?.external_url) {
        previewUrl = job.environment.external_url;
        break;
      }
    }
  }

  return { status: data.status, preview_url: previewUrl };
}

export async function createMergeRequest(args: {
  branchName: string;
  title: string;
  description: string;
  baseBranch: string;
}): Promise<{ mr_url: string; mr_iid: number }> {
  const response = await fetch(
    `${GITLAB_API_URL}/projects/${GITLAB_PROJECT_ID}/merge_requests`,
    {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": GITLAB_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source_branch: args.branchName,
        target_branch: args.baseBranch,
        title: args.title,
        description: args.description,
        remove_source_branch: true,
      }),
    },
  );

  const data = await response.json();
  return { mr_url: data.web_url, mr_iid: data.iid };
}
```

### 7.5 Preview Deployment Hook (Webhook Receiver)

```typescript
// src/webhooks/pipeline.ts

import { getRunByThread, updateRun, getRunById } from "../core/runStore.js";

type PipelineWebhook = {
  branch: string;
  pipeline_id: number;
  pipeline_status: string;
  preview_url: string;
  screenshot_artifacts: string;
  mr_iid?: string;
};

// Express-style handler (or add to Bolt receiver)
export async function handlePipelineComplete(
  payload: PipelineWebhook,
  slackClient: any,
): Promise<void> {
  // Extract runId from branch name: "markup/a1b2c3" → "a1b2c3"
  const runId = payload.branch.replace("markup/", "");
  const run = getRunById(runId);
  if (!run) {
    console.warn(`No run found for branch ${payload.branch}`);
    return;
  }

  if (payload.pipeline_status === "failed") {
    updateRun(runId, { status: "FAILED" });
    await slackClient.chat.postMessage({
      channel: run.channel,
      thread_ts: run.threadTs,
      text: `Pipeline failed for job ${runId}. Check GitLab for details.`,
    });
    return;
  }

  // Store preview info
  updateRun(runId, {
    status: "AWAITING_PREVIEW_APPROVAL" as any,
    previewUrl: payload.preview_url,
  });

  // Post preview with screenshots to Slack
  await slackClient.chat.postMessage({
    channel: run.channel,
    thread_ts: run.threadTs,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ *Preview deployed!*\n\n🔗 <${payload.preview_url}|Open Preview>`,
        },
      },
      {
        type: "image",
        title: { type: "plain_text", text: "Before" },
        image_url: `${payload.screenshot_artifacts}before.png`,
        alt_text: "Before screenshot",
      },
      {
        type: "image",
        title: { type: "plain_text", text: "After" },
        image_url: `${payload.screenshot_artifacts}after.png`,
        alt_text: "After screenshot",
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve & Merge" },
            style: "primary",
            action_id: "markup_approve_preview",
            value: runId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Request Changes" },
            action_id: "markup_refine_preview",
            value: runId,
          },
        ],
      },
    ],
    text: `Preview deployed: ${payload.preview_url}`,
  });
}
```

### 7.6 Slack Messaging Updates (Block Kit Builders)

```typescript
// src/slack/updates.ts

import type { PlanResponse } from "../agent/planner.js";

export function buildPlanBlocks(plan: PlanResponse, runId: string) {
  const summaryLines = [
    `*Plan Summary*`,
    plan.summary ? `Summary: ${plan.summary}` : "Summary: (none)",
    `Target URL: \`${plan.targetUrlPath || "/"}\``,
  ];

  if (plan.risks?.length) {
    summaryLines.push(`Risks: ${plan.risks.join(" · ")}`);
  }

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: summaryLines.join("\n") },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve Plan" },
          style: "primary",
          action_id: "markup_approve_plan",
          value: runId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Revise Plan" },
          action_id: "markup_revise_plan",
          value: runId,
        },
      ],
    },
  ];
}

export function buildPreviewBlocks(args: {
  previewUrl: string;
  screenshotBaseUrl: string;
  runId: string;
}) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *Preview deployed!*\n\n🔗 <${args.previewUrl}|Open Preview>`,
      },
    },
    {
      type: "image",
      title: { type: "plain_text", text: "Before" },
      image_url: `${args.screenshotBaseUrl}before.png`,
      alt_text: "Before screenshot",
    },
    {
      type: "image",
      title: { type: "plain_text", text: "After" },
      image_url: `${args.screenshotBaseUrl}after.png`,
      alt_text: "After screenshot",
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve & Merge" },
          style: "primary",
          action_id: "markup_approve_preview",
          value: args.runId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Request Changes" },
          action_id: "markup_refine_preview",
          value: args.runId,
        },
      ],
    },
  ];
}

export function buildMrCreatedBlocks(mrUrl: string, summary?: string) {
  const text = [
    `🎉 *Merge request created!*`,
    ``,
    `🔗 <${mrUrl}|Open Merge Request>`,
    summary ? `\nSummary: ${summary}` : "",
    ``,
    `The MR is ready for code review and merge.`,
  ].join("\n");

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];
}
```

### ~~7.7 Python Gemini Client~~ — REMOVED

The Python Gemini client (`agent/gemini.py`) has been removed. The GitLab Duo
agent handles all LLM interactions internally.

---

## Appendix: Environment Variables

```bash
# .env.example

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACK_APP_TOKEN=xapp-...

# GitLab
GITLAB_TOKEN=glpat-...
GITLAB_API_URL=https://gitlab.com/api/v4
GITLAB_PROJECT_ID=12345678

# Duo Agent
DUO_AGENT_URL=http://localhost:8200
FRONTEND_ROOT=frontend

# Preview
VERCEL_TOKEN=...
PRODUCTION_URL=https://www.example.com
MARKUP_WEBHOOK_URL=https://markup-bot.example.com
MARKUP_WEBHOOK_SECRET=...
```
