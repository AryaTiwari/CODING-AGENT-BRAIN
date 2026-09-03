# Codebuff / Freebuff public source mirror

This repository contains the public coding-agent source used as reference material for ULTRON's Coding Brain work.

## ULTRON Coding Cortex

A small runnable integration layer now lives in `ultron-cortex/`. It implements the workflow ULTRON needs without requiring the full upstream product to compile first:

- repository discovery and relevant-file ranking
- planning through ULTRON Mark 3's Model League
- structured safe edits
- deterministic project validation
- independent code review and one repair pass

Run the deterministic self-test with:

```powershell
npm run ultron:selftest
```

Start the local Cortex sidecar with:

```powershell
npm run ultron:cortex
```

The copied upstream agent definitions remain under `agents/` for future extraction and improvement.
