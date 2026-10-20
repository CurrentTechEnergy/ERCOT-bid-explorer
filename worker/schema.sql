-- Unit follows for the ERCOT bid explorer (worker/src/index.js). Applied on every deploy, so
-- every statement must be safe to run again.
CREATE TABLE IF NOT EXISTS follows (
  email     TEXT NOT NULL,              -- lower-cased
  unit      TEXT NOT NULL,              -- the Unit page's unit name
  status    TEXT NOT NULL DEFAULT 'pending',   -- pending until the confirmation link is opened, then active
  token     TEXT NOT NULL UNIQUE,       -- secret for this row's confirm and unsubscribe links
  created   TEXT NOT NULL,              -- ISO time the confirmation email was (last) sent
  confirmed TEXT,
  PRIMARY KEY (email, unit)
);
CREATE INDEX IF NOT EXISTS follows_status ON follows (status);
-- sign-ups per address per day, to cap how many confirmation emails one sender can trigger
CREATE TABLE IF NOT EXISTS signups (
  ip  TEXT NOT NULL,
  day TEXT NOT NULL,
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);
