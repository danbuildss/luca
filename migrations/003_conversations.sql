-- Migration 003: Conversation history
-- Stores per-user chat turns so Luca maintains context across messages.
-- Role is 'user' | 'assistant' | 'tool' — mirrors the OpenAI message roles.

CREATE TABLE IF NOT EXISTS conversation_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content     TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_messages_user_created
  ON conversation_messages (user_id, created_at DESC);
