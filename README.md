# Markup

## Project

Markup lets non-technical teams request frontend changes in Slack and get a live preview before anything is merged. A marketing user describes a UI change in plain English, and Markup safely translates that intent into a frontend-only GitHub pull request. Each change is scoped, reviewable, and deployed to a preview environment so stakeholders can see the result before approving it. Markup enforces strict guardrails to avoid backend logic, configuration changes, or large refactors. The goal is not speed at all costs, but trust: clear intent, small diffs, and visual confirmation before code ships.

## Project Structure
```
markup/
├── README.md
├── package.json
├── tsconfig.json
├── .env.example
│
├── src/ # TypeScript orchestration layer
│ ├── index.ts
│ ├── config.ts
│ 
│ ├── sql/
│ │ └── 001_init.sql                 # runs table
│ 
│ ├── db/
│ │ ├── client.ts                    # Postgres connection
│ │ └── runs.ts                      # run persistence helpers
│ 
│ ├── slack/
│ │ ├── app.ts
│ │ ├── handlers.ts
│ │ ├── responses.ts
│ │ └── updates.ts                   # threaded progress updates
│ 
│ ├── core/
│ │ ├── orchestrator.ts              # now becomes a loop using RunStep
│ │ ├── guards.ts
│ │ ├── types.ts
│ │ └── state.ts                     # RunStep enum + RunContext
│ 
│ ├── github/
│ │ ├── client.ts
│ │ ├── repo.ts
│ │ ├── patch.ts
│ │ ├── pr.ts
│ │ └── checks.ts                    # CI status + failure summary
│ 
│ └── utils/
│   ├── diff.ts
│   └── logger.ts
│
├── agent/ # Python Gemini reasoning layer
│ ├── main.py # Agent entrypoint
│ ├── gemini.py # Gemini API wrapper
│ ├── prompts.py # System and task prompts
│ ├── schemas.py # Strict JSON output schemas
│ ├── intent.py # Marketing intent classification
│ ├── planner.py # Page selection and change planning
│ ├── patcher.py # Frontend-only diff generation
│ └── validators.py # Constraint enforcement
│
├── scripts/
│ └── dev.ts # Local development runner
│
└── .github/
└── workflows/
└── preview.yml # CI build and preview deployment
```