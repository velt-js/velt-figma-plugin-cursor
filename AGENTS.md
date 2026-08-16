# AGENTS.md

## Cursor Cloud specific instructions

This repo is a **native Cursor plugin** ("velt-customize") that turns a Figma design into
Velt UI customization on a target React app via a Planner → Builder → Judge loop. It ships
knowledge (`guide/`), deterministic node scripts (`scripts/`, `golden/`), and Cursor
skills/rules/agents/commands. It is a plugin/toolkit, not a long-running service. Standard
usage is documented in `README.md`; only non-obvious context is captured here.

### Gates / tests (this repo)
These zero-dependency node scripts are the effective lint/test suite:
- `node scripts/check-guide.mjs` — guide integrity self-check
- `node scripts/validate.mjs` — manifests + guide self-check + Claude-model policy
- `node golden/run-golden.mjs` — offline calibration checks
- `npm run all` — runs check-guide + validate, then **deploys** skills/rules/commands/agents
  into `~/.cursor/` (re-run after moving the repo). Deploy writes outside the repo; the
  individual gate scripts above are safe read-only checks.
The only npm dependency is `playwright-core` (used by `scripts/capture-block.mjs` for device
screenshots); `npm install` installs it.

### Sibling target app: `ai-privado-implementation`
This Cursor Cloud workspace also checks out a sibling repo,
`../ai-privado-implementation`, which is exactly the kind of **React app with Velt already
working** that this plugin customizes. To exercise the plugin end-to-end you generally need
that app running. Non-obvious caveats for it:
- **Frontend (Next.js, port 3000):** `npm run dev` from that repo's root.
- **Backend (Django, port 8000):** run directly — `cd app/api/velt/backend &&
  ./venv/bin/python manage.py runserver`. Do **not** use `npm run dev:backend` / `dev:all`;
  those use `source`, which fails under npm's `/bin/sh` (dash).
- The backend reads `app/api/velt/backend/.env` (git-ignored); the Cursor update script copies
  it from that repo's root `.env`.
- See `../ai-privado-implementation/AGENTS.md` for the full list of that app's caveats.
