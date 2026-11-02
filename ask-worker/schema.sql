-- "Ask the data" (ask-worker/src/index.js). Applied on every deploy, so every statement must be
-- safe to run again.
-- questions per visitor per UTC day
CREATE TABLE IF NOT EXISTS asks (
  who TEXT NOT NULL,                   -- IP address
  day TEXT NOT NULL,
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (who, day)
);
-- API spend per UTC day, USD (what the Worker computes from each response's token counts)
CREATE TABLE IF NOT EXISTS spend (
  day TEXT PRIMARY KEY,
  usd REAL NOT NULL DEFAULT 0
);
-- every question and answer, for review (GET /log with the owner passcode)
CREATE TABLE IF NOT EXISTS log (
  ts        TEXT NOT NULL,
  who       TEXT NOT NULL,             -- "owner" or a short hash of the IP
  question  TEXT NOT NULL,
  answer    TEXT,
  tools     TEXT,                      -- JSON: [[tool, input], ...]
  model     TEXT,
  rounds    INTEGER,
  in_tok    INTEGER, out_tok INTEGER, cache_read INTEGER, cache_write INTEGER,
  usd       REAL,
  ms        INTEGER,
  stop      TEXT
);
CREATE INDEX IF NOT EXISTS log_ts ON log (ts);
