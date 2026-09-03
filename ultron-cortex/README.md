# ULTRON Cortex

`ultron-cortex/` is the runnable coding subsystem for Project ULTRON. The copied Codebuff/Freebuff agent files in `agents/` remain reference material; Cortex implements the useful workflow in a small standalone service without depending on the full upstream product.

## Workflow

1. Discover and rank repository files (file-picker role).
2. Ask ULTRON Mark 3 for a minimal plan using its Model League.
3. Ask the coding model for structured, minimal file edits.
4. Apply edits only inside the selected workspace with exact replacement guards.
5. Run existing `typecheck`, `test`, or `lint` scripts when available.
6. Ask a separate reviewer model to inspect the result.
7. If review finds issues, perform one repair pass, validate again, and review again.

Mark 3 owns model policy and OmniRoute. Cortex owns repository workflow.

## Start

```powershell
node ultron-cortex/server.mjs
```

Default endpoint: `http://127.0.0.1:8791`.

Environment variables:

- `ULTRON_CODING_BRAIN_HOST` (default `127.0.0.1`)
- `ULTRON_CODING_BRAIN_PORT` (default `8791`)
- `ULTRON_MARK3_URL` (default `http://127.0.0.1:8790`)

## Local deterministic self-test

```powershell
node ultron-cortex/selftest.mjs
```

The self-test does not call an AI model. It verifies file discovery, relevance ranking, safe edit application, and traversal protection.

## API

`GET /health`

`POST /run`

```json
{
  "task": "Fix the wake-word state bug and test it",
  "workspace": "C:\\Users\\aryat\\Project-Ultron",
  "mode": "apply"
}
```

Modes: `inspect`, `plan`, `apply`.

## Safety

Cortex refuses paths outside the workspace and protected directories such as `.git` and `node_modules`. Replace edits require an exact unique old string. Validation executes only existing package scripts (`typecheck`, `test`, `lint`) and never arbitrary model-generated shell commands.
