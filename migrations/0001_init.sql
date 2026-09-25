-- D1 schema: the structured, queryable record of everything the agent does.
-- Vectorize holds only embeddings + ids; D1 holds the actual content.

-- Conversation transcript (durable audit copy of the agent's short-term state).
CREATE TABLE IF NOT EXISTS messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content          TEXT NOT NULL,
  investigation_id TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);

-- One row per workflow run.
CREATE TABLE IF NOT EXISTS investigations (
  id              TEXT PRIMARY KEY,           -- also the Workflow instance id
  conversation_id TEXT NOT NULL,
  service         TEXT,
  user_message    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  steps_json      TEXT NOT NULL DEFAULT '[]', -- progress, for polling clients
  result_json     TEXT,                       -- InvestigationResult
  error           TEXT,
  created_at      TEXT NOT NULL,
  completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_investigations_conversation ON investigations (conversation_id, created_at);

-- Long-term memory: distilled incident knowledge (not raw conversation).
-- The same id is used for the vector in Vectorize (namespace "incidents").
CREATE TABLE IF NOT EXISTS incident_memories (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT,
  service          TEXT NOT NULL,
  problem          TEXT NOT NULL,
  cause            TEXT NOT NULL,
  resolution       TEXT NOT NULL,
  symptoms_json    TEXT NOT NULL DEFAULT '[]',
  evidence_json    TEXT NOT NULL DEFAULT '[]',
  occurrences      INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incident_memories_service ON incident_memories (service, last_seen_at);

-- Runbook knowledge base (seeded from worker/runbooks). Vector ids = slug.
CREATE TABLE IF NOT EXISTS runbooks (
  slug         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  content_json TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
