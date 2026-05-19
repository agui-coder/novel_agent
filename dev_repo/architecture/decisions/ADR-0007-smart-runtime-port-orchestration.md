# ADR-0007: Smart Runtime Port Orchestration

Date: 2026-05-13

## Status

Accepted.

## Context

The local runtime currently has two competing port truths:

- `start_all.ps1` starts and checks the canonical backend on port `8000` and frontend on port `5173`.
- The live Dify LoreGit ToolProvider row points to `http://host.docker.internal:8001`.

This split makes the author-facing Dify chain fragile. The frontend can be healthy through `8000` while Dify tools still require a second backend on `8001`. The result is not an agent-quality problem; it is a runtime topology problem.

Dify live PostgreSQL remains the source of truth for ToolProvider configuration. YAML exports are evidence only.

## Decision

The startup orchestrator becomes the local runtime port fact source.

On startup it should:

1. Prefer the historical default ports (`8000` for backend and `5173` for frontend).
2. Reuse a port only when the owner is the canonical expected process and its health check passes.
3. Allocate the next available port when the preferred port is occupied by a noncanonical process and dynamic allocation is enabled.
4. Write the selected ports to `.runtime/ports.json`.
5. Start frontend with its proxy pointing to the selected backend port.
6. Synchronize the live Dify LoreGit ToolProvider endpoint so every `host.docker.internal:<port>` URL points to the selected backend port.
7. Verify Dify sandbox reachability against the selected backend port.

The ToolProvider sync may update only endpoint URLs inside the live `tool_api_providers` row. It must not add, remove, or change tool operations, workflow prompts, agent routing, or book file write semantics.

## Unchanged Boundaries

- Dify workflow graphs and agent prompts remain owned by their existing patch scripts and contracts.
- The LoreGit OpenAPI operation set is unchanged.
- Frontend still talks to Flask through the Vite proxy.
- Dify still calls Flask/LoreGit through `host.docker.internal`.
- No Dify schema migration is introduced.
- No book workspace data is changed.

## Verification

Acceptance requires all of the following:

- `.runtime/ports.json` records the selected backend and frontend ports.
- `start_all.ps1 -Status` reports the same selected ports.
- Backend `/health` succeeds on the selected backend port.
- Frontend proxy can reach the selected backend port.
- Live Dify `tool_api_providers.schema` and `tools_str` contain only `host.docker.internal:<selected_backend_port>` for LoreGit endpoints.
- Dify sandbox can reach `http://host.docker.internal:<selected_backend_port>/health`.
- A Dify LoreGit read-tool smoke succeeds through the frontend/Dify/backend chain.

## Residual Risk

If Dify containers cannot resolve `host.docker.internal`, the endpoint sync will correctly update the port but the sandbox reachability check will fail. That is a Docker/Dify network issue and should stop execution before any claim of acceptance.
