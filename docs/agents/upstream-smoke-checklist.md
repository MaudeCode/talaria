# Upstream Live-Smoke Checklist

Run sheet for the manual live-smoke that gates an `UPSTREAM_TESTED_SHA` advance.
Derived directly from `CONTRACT_TESTS.md` → "Endpoint Priority" and gated by
`CONTRACT_TESTS.md` → "Advance Policy". This is the owner-run artifact for
issue #181 (the live smoke + pin advance); this file just gives the owner a
top-to-bottom run sheet so nothing is invented at the keyboard.

- **Who runs this:** the repo owner, against the live server.
- **What it is NOT:** it does not move the pin by itself, start Docker, or assert
  real Swift `Codable` decode. v1 is **visual** JSON inspection — eyeball that
  the annotated top-level key(s) are present and shaped right.
- **Decode check = visual.** Each read-only call lists the top-level JSON key(s)
  the app's tolerant `Codable` model reads. "Green" means those keys are present
  with a plausible value, not that a byte-exact schema matched.

> ⚠️ **Disposable data only.** The mutating section creates a throwaway session
> and only ever touches that session (and any child it branches). Never run the
> mutating calls against a production or owner session.

---

## Setup

Some steps below read from `.codex-tmp/hermes-webui` — the repo's pinned, read-only
local clone of the public upstream. If it is missing, clone it first:

```bash
git clone https://github.com/MaudeCode/hermes-webui .codex-tmp/hermes-webui
```

The directory is gitignored; never modify it — it exists so tags/commits can be
resolved locally against the exact upstream source.

```bash
# Target server. No trailing slash.
BASE="https://<your-server>"

# Cookie jar for the authenticated session (written by login, read by every
# later call). Keep it out of the repo.
JAR="$(mktemp -t hermes-smoke-cookies)"

# jq is used only to pretty-print / eyeball top-level keys. Optional but handy.
```

`curl` flags used below:
- `-s` silent, `-S` still show errors.
- `-c "$JAR"` write cookies (login only), `-b "$JAR"` send cookies (every other call).
- `-w '\nHTTP %{http_code}\n'` print the status code so you can eyeball 200s.

Native clients send **no** `Origin`/`Referer` (the upstream CSRF contract for
non-browser clients — see `CONTRACT_TESTS.md` "Current Slice"). Plain `curl`
already sends neither, so do **not** add them.

---

## Step 0 — Capture the server version (and map it to a SHA)

Goal: record exactly which upstream release this smoke validated, so the
eventual pin move in `UPSTREAM_TESTED_SHA` names the real commit.

`GET /api/settings` returns `webui_version` and `agent_version`, but it is an
**authenticated** endpoint — so run the read in Step 2 **after** login. Do the
SHA mapping here once you have the version string.

Map the reported `webui_version` (a release tag like `v0.50.xxx`) to its peeled
commit using the repo-local upstream clone:

```bash
# After you have WEBUI_VERSION from Step 2 (e.g. v0.50.300):
git -C .codex-tmp/hermes-webui fetch --tags --quiet
git -C .codex-tmp/hermes-webui rev-parse "v0.50.300^{commit}"
```

Write down: `webui_version`, `agent_version`, and the peeled commit SHA. That
SHA is the candidate value for `UPSTREAM_TESTED_SHA` if the smoke goes green.

---

## Step 1 — Authenticate

`POST /api/auth/login` with `{"password": "..."}`. On success the server sets the
signed `hermes_session` cookie; `-c "$JAR"` captures it for every later call.

```bash
read -rs -p "Server password: " PASSWORD; echo

curl -sS -c "$JAR" -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"password\": \"$PASSWORD\"}" \
  -w '\nHTTP %{http_code}\n'
unset PASSWORD
```

Green: HTTP 200 and body `{"ok": true}`. Confirm the cookie landed:

```bash
curl -sS -b "$JAR" "$BASE/api/auth/status" -w '\nHTTP %{http_code}\n'
# expect: logged_in true, auth_enabled true
```

---

## Step 2 — Read-only checks (24 GETs)

Safe against live data — these never mutate. Each line is annotated with the
top-level JSON key(s) to eyeball. Run them in order; all should be HTTP 200.

Replace `<...>` placeholders with real values from earlier responses
(`SID` = a real session id from `/api/sessions`; paths from `/api/list`).

```bash
# 1. health (unauthenticated, but harmless with the cookie)   -> status, sessions, uptime_seconds
curl -sS -b "$JAR" "$BASE/health" | jq '{status, sessions, uptime_seconds}'

# 2. auth status                                               -> auth_enabled, logged_in
curl -sS -b "$JAR" "$BASE/api/auth/status" | jq '{auth_enabled, logged_in}'

# 3. sessions list                                            -> sessions[], cli_count, server_time
curl -sS -b "$JAR" "$BASE/api/sessions" | jq '{count: (.sessions|length), cli_count, server_time}'

# --- pick a real read-only session id to probe (do NOT mutate it) ---
SID="$(curl -sS -b "$JAR" "$BASE/api/sessions" | jq -r '.sessions[0].session_id')"

# 4. single session (messages on)                             -> session{}
curl -sS -b "$JAR" "$BASE/api/session?session_id=$SID&messages=1" | jq '.session | {session_id, title, message_count}'

# 5. session status                                           -> session_id, is_streaming
curl -sS -b "$JAR" "$BASE/api/session/status?session_id=$SID" | jq '{session_id, is_streaming}'

# 6. projects                                                 -> projects[]
curl -sS -b "$JAR" "$BASE/api/projects" | jq '{count: (.projects|length)}'

# 7. workspaces                                               -> workspaces[], last
curl -sS -b "$JAR" "$BASE/api/workspaces" | jq '{count: (.workspaces|length), last}'

# 8. workspace suggestions                                    -> suggestions[], prefix
curl -sS -b "$JAR" "$BASE/api/workspaces/suggest?prefix=/" | jq '{suggestions, prefix}'

# 9. directory list (path optional)                           -> entries[], path, workspace
curl -sS -b "$JAR" "$BASE/api/list?session_id=$SID&path=" | jq '{count: (.entries|length), path, workspace}'

# 10. file (pick a real file path from the list above)        -> content, path, language
curl -sS -b "$JAR" "$BASE/api/file?session_id=$SID&path=<file-path>" | jq '{path, language, size}'

# 11. raw file                                                -> (raw bytes, not JSON) HTTP 200
curl -sS -b "$JAR" "$BASE/api/file/raw?session_id=$SID&path=<file-path>" -w '\nHTTP %{http_code}\n' -o /dev/null

# 12. models                                                  -> groups[]/models[], default_model, active_provider
curl -sS -b "$JAR" "$BASE/api/models" | jq '{default_model, active_provider}'

# 13. providers                                               -> providers[], active_provider
curl -sS -b "$JAR" "$BASE/api/providers" | jq '{active_provider}'

# 14. settings  (Step 0 version source)                       -> webui_version, agent_version, bot_name
curl -sS -b "$JAR" "$BASE/api/settings" | jq '{webui_version, agent_version, bot_name}'
WEBUI_VERSION="$(curl -sS -b "$JAR" "$BASE/api/settings" | jq -r '.webui_version')"
echo "webui_version = $WEBUI_VERSION  (map to a SHA per Step 0)"

# 15. reasoning                                               -> ok, show_reasoning, reasoning_effort/effort
curl -sS -b "$JAR" "$BASE/api/reasoning" | jq '{ok, show_reasoning, reasoning_effort, effort}'

# 16. profiles                                                -> profiles[], active
curl -sS -b "$JAR" "$BASE/api/profiles" | jq '{count: (.profiles|length), active}'

# 17. personalities                                           -> personalities[]
curl -sS -b "$JAR" "$BASE/api/personalities" | jq '{count: (.personalities|length)}'

# 18. commands                                                -> commands[]
curl -sS -b "$JAR" "$BASE/api/commands" | jq '{count: (.commands|length)}'

# 19. crons                                                   -> jobs[]
curl -sS -b "$JAR" "$BASE/api/crons" | jq '{count: (.jobs|length)}'

# 20. crons status                                            -> job_id, running, running_jobs
curl -sS -b "$JAR" "$BASE/api/crons/status" | jq '{running, running_jobs}'

# 21. crons output (job_id from /api/crons; limit optional)   -> job_id, outputs[]
curl -sS -b "$JAR" "$BASE/api/crons/output?job_id=<job-id>&limit=20" | jq '{job_id, count: (.outputs|length)}'

# 22. skills                                                  -> skills[]
curl -sS -b "$JAR" "$BASE/api/skills" | jq '{count: (.skills|length)}'

# 23. skill content (name from /api/skills)                   -> name, content, linked_files
curl -sS -b "$JAR" "$BASE/api/skills/content?name=<skill-name>" | jq '{name, has_content: (.content!=null)}'

# 24. memory                                                  -> memory, user, memory_path
curl -sS -b "$JAR" "$BASE/api/memory" | jq '{has_memory: (.memory!=null), memory_path}'
```

Green for this section: every call HTTP 200 and the annotated top-level key(s)
present with a plausible value. Calls that need a `<...>` you cannot supply
(no files, no crons, no skills on the server) may be skipped — record which and
why.

---

## Step 3 — Disposable-session mutate sequence

Creates **one** throwaway session, exercises
branch / truncate / rename / pin / archive / move / delete against it, then
deletes it (and the child created by branch). All bodies use `session_id`
(the encoder sends snake_case). All are `POST` with a JSON body.

```bash
# --- create the throwaway session ---
DSID="$(curl -sS -b "$JAR" -X POST "$BASE/api/session/new" \
  -H 'Content-Type: application/json' -d '{}' \
  | jq -r '.session.session_id')"
echo "disposable session = $DSID"   # sanity-check this is a NEW id, not a real one

# rename
curl -sS -b "$JAR" -X POST "$BASE/api/session/rename" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\": \"$DSID\", \"title\": \"smoke-disposable\"}" \
  | jq '{ok, error}'

# pin
curl -sS -b "$JAR" -X POST "$BASE/api/session/pin" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\": \"$DSID\", \"pinned\": true}" \
  | jq '{ok, error}'

# archive
curl -sS -b "$JAR" -X POST "$BASE/api/session/archive" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\": \"$DSID\", \"archived\": true}" \
  | jq '{ok, error}'

# move (project_id null = no project; safe)
curl -sS -b "$JAR" -X POST "$BASE/api/session/move" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\": \"$DSID\", \"project_id\": null}" \
  | jq '{ok, error}'

# branch (creates a CHILD session — capture its id so we can delete it too)
BSID="$(curl -sS -b "$JAR" -X POST "$BASE/api/session/branch" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\": \"$DSID\"}" \
  | jq -r '.session.session_id // .session_id // empty')"
echo "branched child session = $BSID"

# truncate (keep_count 0 on an empty session is a safe no-op)
curl -sS -b "$JAR" -X POST "$BASE/api/session/truncate" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\": \"$DSID\", \"keep_count\": 0}" \
  -w '\nHTTP %{http_code}\n' -o /dev/null

# --- cleanup: delete the child (if any) then the disposable session ---
if [ -n "$BSID" ]; then
  curl -sS -b "$JAR" -X POST "$BASE/api/session/delete" \
    -H 'Content-Type: application/json' \
    -d "{\"session_id\": \"$BSID\"}" | jq '{ok, error}'
fi

curl -sS -b "$JAR" -X POST "$BASE/api/session/delete" \
  -H 'Content-Type: application/json' \
  -d "{\"session_id\": \"$DSID\"}" | jq '{ok, error}'

# verify both are gone
curl -sS -b "$JAR" "$BASE/api/sessions" \
  | jq --arg d "$DSID" --arg b "$BSID" \
    '[.sessions[].session_id] | {disposable_present: (index($d)!=null), child_present: (index($b)!=null)}'
# expect: both false
```

Green for this section: every mutate returns `ok: true` (or HTTP 200 for the
no-body checks), the branch child id is captured, and the final verify shows
**both** sessions gone.

Cleanup safety: if anything aborts mid-sequence, delete `$DSID` (and `$BSID` if
set) before stopping, and remove the cookie jar: `rm -f "$JAR"`.

---

## Step 4 — Green criteria & recording

**Green** = both must hold (matches `CONTRACT_TESTS.md` "Advance Policy" trigger):

1. **All** read-only checks in Step 2 returned HTTP 200 and the annotated
   top-level key(s) decoded visually.
2. The Step 3 mutate sequence ran end-to-end against the disposable session(s)
   only, and both were deleted (final verify shows them gone). No production or
   owner session was touched.

**If green — advance the pin** (per "Advance Policy" → "How to advance"):

1. Replace the SHA in `UPSTREAM_TESTED_SHA` with the peeled commit from Step 0.
2. Update the human-readable tag references in `CONTRACT_TESTS.md`, `README.md`,
   and `DEVELOPMENT.md` to the validated release.
3. Commit the pin move with a one-line note of which smoke validated it.

**Where to record the result** (per "Advance Policy" → "Cadence and owner"):
the smoke outcome + chosen pin go in issue #181. If the smoke was **skipped or
held**, the pin stays and the reason is recorded there.

**Cleanup:** `rm -f "$JAR"` when done.

---

## References

- `CONTRACT_TESTS.md` → "Endpoint Priority" (the source list this sheet mirrors)
  and "Advance Policy" (the gate + how to advance the pin).
- Issue #181 — the owner task to run this smoke and advance `UPSTREAM_TESTED_SHA`.
- `Talaria/Networking/Endpoints.swift` — authoritative paths/methods/query
  params every `curl` above mirrors.
