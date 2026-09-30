# omega-mcp

Single source of truth for the Omega MCP bridge used by GenCode (Mac) and
opencode (Oracle). One codebase, both hosts — host differences live in
environment variables, never in forks.

## Files

| File              | What                                          |
| ----------------- | --------------------------------------------- |
| `server.mjs`      | MCP stdio server: `run_process`, tool routing |
| `tools-ext.mjs`   | `omega_batch`, `omega_read`, `omega_grep`, `omega_edit`, `omega_quota`, `omega_health`, `db_query`, `vfs_local_write`, … |
| `batch-guard.mjs` | Dry-run guard for batch steps (refuse writes outside /tmp) |
| `*.test.mjs`      | Self-running regression suites (`npm test`)   |

Zero npm dependencies. `node >= 20`.

## Host config (in `opencode.json`, not in code)

```json
"forge": {
  "type": "local",
  "command": ["<node>", "<clone-dir>/server.mjs"],
  "cwd": "~",
  "environment": {
    "OMEGA_JOB_DIR": "/tmp/omega-jobs",
    "OMEGA_ARTIFACT_DIR": "<artifacts-dir>",
    "OMEGA_DB": "<agent.db path>",
    "OMEGA_DB_WRITES": "1",
    "OMEGA_QUOTA_SCRIPT": "<giz-quota.sh path>"
  }
}
```

| Var                  | Mac | Oracle | Meaning                                    |
| -------------------- | --- | ------ | ------------------------------------------ |
| `OMEGA_DB_WRITES=1`  | yes | no     | Fenced writes (DML, whitelisted tables, snapshotted). Unset = read-only refusal |
| `OMEGA_DB`           | Mac agent.db | Oracle agent.db | Database `db_query` reads/writes |
| `OMEGA_QUOTA_SCRIPT` | giz-quota.sh | — | Absent = `omega_quota` degrades to a pointer |
| `OMEGA_JOB_DIR` / `OMEGA_ARTIFACT_DIR` / `OMEGA_CWD` | per host | per host | Scratch locations |
| `OMEGA_DB_BACKUP_KEEP` | 10 | n/a | Snapshots kept; `0` disables pruning |
| `OMEGA_FORCE_GREP` | unset | n/a | `1` pins omega_grep to the grep fallback |

Batch shells get `/opt/homebrew/bin` + `/usr/local/bin` prepended to PATH
(`withToolPath` in `server.mjs`); a caller-supplied PATH still wins.

## Workflow

- Change here, `npm test`, commit, push. Both hosts only ever `pull`.
- After pulling new code, **restart the host agent** — the MCP server loads
  code once at startup; re-testing on a stale process spins forever.
- Never commit host paths, secrets, or `.bak` files.

## Host PATH is minimal — the module fixes it for itself

GenCode launches the server with `bundled-resources/bin` + system dirs and no
Homebrew prefix, so a bare `rg` probe fails even though ripgrep is installed.
`tools-ext.mjs` prepends `/opt/homebrew/bin:/usr/local/bin` to its own
`process.env.PATH` at import time, so every binary probe in the module (`rg`,
`sqlite3`, `python3`) resolves. `server.mjs:withToolPath()` does the same for
batch child shells; an explicit `environment.PATH` still wins.

If `omega_health` reports ripgrep absent, it now prints the PATH it searched.

## omega_grep engine parity

`rg` is the primary engine; `grep -E` is the fallback for hosts without it
(Oracle). Two rules keep them honest:

- **The fallback speaks ERE.** Plain BRE treats `a|b` as a literal pipe and
  returns "(no matches)" for a file containing both — a silent wrong answer
  that reads exactly like "not there".
- **Exactly one matcher flag, never two.** GNU grep ≥ 3.7 rejects `-E -F` as
  "conflicting matchers" (exit 2) while BSD grep silently lets the last win, so
  passing both works on the Mac and fails on Oracle.

Output assertions cannot catch the second class: on a tolerant platform the
output is correct. `OMEGA_GREP_TRACE=1` dumps the exact argv, and the suite
asserts on that — so a Mac-only run still catches what would fail on Linux.
Set `OMEGA_FORCE_GREP=1` to exercise the fallback on a host that has `rg`.

## db snapshot retention

Every fenced write copies the whole database (69 MB here), so snapshots are
pruned to the newest `OMEGA_DB_BACKUP_KEEP` (default 10). A snapshot is
collapsed out of WAL mode so it is a single self-contained file, and the
rollback line in the receipt removes the live `-wal`/`-shm` before restoring —
copying over a live WAL database leaves stale pages that SQLite replays on the
next open. `OMEGA_DB_BACKUP_KEEP=0` disables pruning.

