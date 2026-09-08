-- Rebuildable local ranking data. Memory records and governance remain authoritative.
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider = 'local_transformers'),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 256),
  model_revision TEXT NOT NULL CHECK(
    length(model_revision) = 64 AND model_revision NOT GLOB '*[^0-9a-f]*'
  ),
  dimensions INTEGER NOT NULL CHECK(typeof(dimensions) = 'integer' AND dimensions BETWEEN 1 AND 4096),
  index_version INTEGER NOT NULL CHECK(typeof(index_version) = 'integer' AND index_version >= 1),
  content_fingerprint TEXT NOT NULL CHECK(
    length(content_fingerprint) = 64 AND content_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  memory_revision INTEGER NOT NULL CHECK(typeof(memory_revision) = 'integer' AND memory_revision >= 1),
  vector BLOB NOT NULL CHECK(typeof(vector) = 'blob' AND length(vector) = dimensions * 4),
  generated_at INTEGER NOT NULL CHECK(typeof(generated_at) = 'integer' AND generated_at >= 0)
);

CREATE INDEX idx_memory_embeddings_model
  ON memory_embeddings(provider, model, model_revision, index_version, dimensions);
