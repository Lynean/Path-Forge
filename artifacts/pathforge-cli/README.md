# PathForge CLI

The CLI is a source-run terminal view of the existing PathForge application
pipeline. It does not duplicate the planner, tutor, graph retrieval, sandbox,
policy, persistence, or tool logic. Instead, it starts the existing Express API
inside the CLI process on a random loopback port and consumes the same JSON/SSE
routes as the React app.

From the repository root:

```powershell
pnpm pathforge:cli -- "C:\absolute\path\to\your\project"
```

If a prior CLI process was interrupted, resume the newest persisted project
without regenerating its map:

```powershell
pnpm pathforge:cli -- "C:\absolute\path\to\your\project" --resume-latest
```

The CLI asks for a project name and description, attaches the supplied directory,
and generates the node map immediately.

Inside a node:

- `/next` opens the next step and lazily generates its grounded detail.
- `/back` returns to the previous step.
- `/esc` returns to the node map.
- `/done` completes the node and unlocks dependents.
- `/help` shows commands.
- `/quit` exits.
- Any text without `/` is sent to the existing tutor agent.

No frontend or API bundle is built. Changes to API, harness, tools, or prompts are
picked up the next time the command starts.

Local state is persisted in `%USERPROFILE%\pathforge-cli-db`, and durable agent
memory in `%USERPROFILE%\pathforge-agent-home`. If `OPENROUTER_API_KEY` is absent,
the CLI uses `PATHFORGE_PROXY_URL` (default `http://127.0.0.1:8080`) and a stable,
hashed device identifier for the free-tier proxy.

The real project folder is available to read-only inspection tools. Command
execution still uses the existing filtered Docker sandbox and command policy.
Custom Docker environments still require an explicit terminal approval. Agent
edits remain staged proposals; the CLI does not silently write them into the real
workspace.
