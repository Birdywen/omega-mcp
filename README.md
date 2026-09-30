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

Batch shells get `/opt/homebrew/bin` + `/usr/local/bin` prepended to PATH
(`withToolPath` in `server.mjs`); a caller-supplied PATH still wins.

## Workflow

- Change here, `npm test`, commit, push. Both hosts only ever `pull`.
- After pulling new code, **restart the host agent** — the MCP server loads
  code once at startup; re-testing on a stale process spins forever.
- Never commit host paths, secrets, or `.bak` files.
