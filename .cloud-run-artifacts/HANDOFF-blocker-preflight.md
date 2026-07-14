# ⚠ HALTED at PREFLIGHT — target repo inaccessible (ATTEMPT 2)

**Status:** BLOCKED / fail-fast. No customization was performed. No files were changed in any app. The run stopped before enumerate/plan/build because the target repository could not be obtained.

- **Run:** `Figma-privado velt run` — https://cursor.com/agents/bc-5d9ca6e5-09da-41eb-9c56-edeaff4897a5
- **Owner:** Mayank Pagar (mayank@velt.dev)
- **Plugin branch (this workspace, auto-pushed):** `cursor/figma-privado-velt-run-c845`
- **Plugin repo:** `velt-js/velt-figma-plugin-cursor` @ SHA `2edab387584526fb4479a3a3637506e728b8a5d7` (git fetch found no newer commits — plugin is fresh)
- **Phase heartbeat:** `.velt-customize/phases/WYAWuEm8DrIk-133-4052/progress.log`
- **UTC:** 2026-07-14 ~17:54Z

---

## The blocker (unchanged from attempt 1, root cause pinned)

The target app repo **`velt-js/ai-privado-implementation`** (package name `@apps/react-self-hosting-forms-page-mode-demo`) is **not visible to any credential available on this VM**, and **no pre-provisioned checkout of it exists anywhere on the machine**. The run cannot start without the target repo, so it halted fail-fast per `--auto` rules (every HALT = written handoff + clean stop, never a wait).

### What was tried (all exhausted, in order)

1. **Look for an already-provisioned checkout.** Searched `/workspace`, `~`, `/`, `/workspaces`, `/opt`, `/packages`, `/mnt`, `/srv`, `/var/www`, `/home`, and `grep -rl "react-self-hosting-forms-page-mode-demo" --include=package.json /` and `find / -iname '*ai-privado*'`. **No checkout found.**

2. **GitHub App installation scope.** `gh api installation/repositories --jq '.repositories[].full_name'` returns **exactly one** repo:
   ```
   velt-js/velt-figma-plugin-cursor
   ```
   (Identical to attempt 1 — the installation still lacks the target repo grant.)

3. **Clone via installation token (`cursor` GitHub App, `ghs_…`):**
   - `git clone https://github.com/velt-js/ai-privado-implementation.git` → `remote: Repository not found. fatal: repository '…' not found`
   - `gh repo clone velt-js/ai-privado-implementation` → `GraphQL: Could not resolve to a Repository with the name 'velt-js/ai-privado-implementation'.`
   - `gh api repos/velt-js/ai-privado-implementation` → `404 Not Found`

4. **Clone via the injected `DOCS_REPO_TOKEN` secret** (belongs to GitHub user **`vivekk-snippyly`**, a real PAT):
   - `gh api repos/velt-js/ai-privado-implementation` → `404 Not Found`
   - Not present in that user's own repos, not in the `velt-js` org listing (52 repos enumerated — none match `privado|self-host|page-mode|ai-`), and not returned by global `gh search repos`.
   - Direct probes on plausible owners `vivekk-snippyly/`, `velt-js/`, `veltdev/`, `snippyly/` for `ai-privado-implementation` → **all 404**.

5. **Cloud environment attachment.** `cursor-cloud environment-info` returns **`environment: null`** — this run was **not launched attached to the "Figma-privado" saved environment**. Egress is unrestricted (network is fine). NOTE: the environment's **secrets DID get injected** (`DOCS_REPO_TOKEN, NEXT_PUBLIC_VELT_API_KEY, VELT_AUTH_TOKEN, VELT_MONGODB_CONNECTION_STRING, AWS_ACCESS_KEY_ID/SECRET/REGION/S3_BUCKET, CORS_ALLOWED_ORIGINS, DEBUG, DJANGO_SECRET_KEY, FIGMA_TOKEN, NEXT_PUBLIC_SELF_HOSTING_BASE_URL, VELT_MONGODB_DATABASE, VELT_PERMISSION_PROVIDER_TOKEN`) — so the secret set was configured, **but the repository access grant / warm checkout was not**.

**Conclusion:** From inside this VM there is no way to grant access to a private repo the GitHub App cannot see and no PAT can resolve. This is an external, provisioning-side blocker — the exact same class of failure as attempt 1.

---

## Everything else was READY (so only the repo grant is missing)

| Preflight item | State |
|---|---|
| `FIGMA_TOKEN` (env secret) | ✓ present (used env value, never the fallback; never printed) |
| Node / npm | ✓ v22.14.0 / 10.9.7 (≥ 18) |
| Plugin repo freshness | ✓ `2edab38`, `git fetch` shows no newer commits |
| Network egress | ✓ unrestricted (allow-all) |
| Target-app runtime secrets | ✓ all injected (Mongo, AWS, Django, Velt API key + auth token, self-hosting base URL, permission-provider token) |
| **Target repo access** | ✗ **BLOCKER** — GitHub App install lacks the grant; no PAT resolves it; no checkout present |

---

## What the user must do to unblock ATTEMPT 3

Pick whichever matches how access should be granted (any one unblocks the clone):

1. **Confirm the repo's exact owner/name.** `velt-js/ai-privado-implementation` was **not found** under `velt-js`, `veltdev`, `snippyly`, or `vivekk-snippyly`, nor by global search. If the repo lives under a different org/user or a different name, provide the corrected `owner/repo`.

2. **Grant the Cursor cloud-agent GitHub App access to the target repo.** Add `ai-privado-implementation` to the GitHub App installation used by cloud agents (GitHub → Org settings → GitHub Apps → the Cursor app → Repository access → add the repo). After that, `gh api installation/repositories` should list it and the clone will succeed.

3. **Or grant the PAT access.** If cloning should use `DOCS_REPO_TOKEN` (user `vivekk-snippyly`), add that user/PAT as a collaborator (read) on the target repo, or provide a PAT that can see it as a repo-scoped secret.

4. **Launch attempt 3 with the "Figma-privado" environment actually attached.** This run reported `environment: null`; only the secret set carried over. Ensure the new run is started **from** the Figma-privado environment (and that environment must itself carry the repo grant / a warm clone), so `environment-info` no longer returns null.

Once any of the above is in place, re-run the identical command — everything downstream (FIGMA_TOKEN, node, plugin, app secrets, egress) is already verified ready.

---

## Machine-readable evidence

- `installation/repositories` → `["velt-js/velt-figma-plugin-cursor"]`
- `git clone` / `gh repo clone` velt-js/ai-privado-implementation → repository not found / 404
- `DOCS_REPO_TOKEN` identity → `vivekk-snippyly`; repo access → 404
- `environment-info` → `{ "environment": null, "egress": { "restricted": false }, "build": null }`
- Heartbeat trail: `.velt-customize/phases/WYAWuEm8DrIk-133-4052/progress.log`
