# Tech Stack

## Recommendation

Use TypeScript / Node.js as the main runtime.

Reasons:

- Pi SDK is TypeScript-native.
- Gateway, tool registry, web UI, and agent event streaming fit Node well.
- The project values fast experimentation.
- Python can still be used as a worker sidecar for ML-heavy tasks.

## Initial Stack

| Area | Choice |
|---|---|
| Runtime | Node.js 22+ |
| Language | TypeScript |
| API server | Fastify or Hono |
| Bot protocol | NapCat / OneBot v11 WebSocket |
| Database | SQLite with WAL |
| ORM | Drizzle ORM |
| Keyword search | SQLite FTS |
| Vector search | sqlite-vec, LanceDB, or Qdrant later |
| Jobs | SQLite job table first; BullMQ + Redis later |
| Agent core | Pi SDK |
| UI | React + Vite when needed |
| Observability | structured logs + OpenTelemetry-ready spans |
| Sandbox | Docker first; stronger isolation later |

## Storage Strategy

SQLite should be the source of truth for MVP:

- Easy local deployment.
- Simple backups.
- Good enough for early QQ group volume.
- Works well with WAL mode.

Vector and graph storage can start as side tables:

- `memory_embeddings`
- `graph_nodes`
- `graph_edges`

Move to dedicated services only after retrieval quality or scale requires it.

## Python Sidecar

Use Python only for tasks that benefit clearly from Python libraries:

- Local embedding models.
- Rerankers.
- Speech or image preprocessing.
- Experimental memory extraction pipelines.

Keep sidecar communication explicit through HTTP, RPC, or job queues.

