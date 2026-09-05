# Tech Stack

## Current Implementation

| Area | Choice |
|---|---|
| Runtime | Node.js 22.19+ |
| Language | TypeScript |
| API server | Node `http` with dedicated application and governance servers |
| Bot protocol | NapCat / OneBot v11 WebSocket and optional reverse HTTP |
| Database | SQLite with WAL |
| Database driver | `better-sqlite3` with explicit repositories and migrations |
| Keyword search | SQLite FTS |
| Jobs | SQLite-backed durable workers |
| Agent core | Pi SDK (`@earendil-works/pi-agent-core` and `pi-ai`) |
| Governance UI | Bundled HTML/CSS/JavaScript browser assets over the governance server |
| Observability | Structured Pino logs, SQLite audit rows, and Prometheus metrics |
| Sandbox | In-process policy boundary with bounded output; Docker is a future backend |

The runtime does not currently use Fastify, Hono, Drizzle, React, Vite, a
vector database, Redis, BullMQ, or a Python sidecar. Those remain possible
future choices only after a documented requirement and acceptance plan.

## Storage Strategy

SQLite is the source of truth for the current runtime:

- Easy local deployment.
- Simple backups.
- Good enough for early QQ group volume.
- Works well with WAL mode.

Vector and graph storage are not part of the current runtime. If retrieval
quality or scale later requires them, they can start as side tables:

- `memory_embeddings`
- `graph_nodes`
- `graph_edges`

Move to dedicated services only after an acceptance-backed design decision.

## Deferred Integrations

Python may be used later for a clearly justified embedding, reranking, speech,
image, or experimental extraction sidecar:

- sidecar communication must remain explicit through HTTP, RPC, or durable jobs;
- it must not bypass memory provenance or governance rules.
