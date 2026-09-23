-- V6.4: physical stock audit (scan sessions)
CREATE TABLE IF NOT EXISTS audit_session (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  location   text,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  notes      text,
  started_by integer REFERENCES users(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  closed_by  integer REFERENCES users(id),
  closed_at  timestamptz
);
CREATE TABLE IF NOT EXISTS audit_scan (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id   integer NOT NULL REFERENCES audit_session(id) ON DELETE CASCADE,
  scanned_code text NOT NULL,
  label_id     integer REFERENCES labels(id),
  item_id      integer REFERENCES items(id),
  item_code    text,
  result       text NOT NULL CHECK (result IN ('matched','unexpected','unknown','duplicate')),
  location     text,
  scanned_by   integer REFERENCES users(id),
  scanned_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scan_session ON audit_scan(session_id);
