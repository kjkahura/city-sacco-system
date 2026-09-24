-- Write-offs are requested and approved by different people (maker-checker),
-- may be dated back, and are listed in a register. A tenant with one
-- manager may turn the approval step off; the request is still recorded,
-- approved by the same user, so the register reads the same either way.

ALTER TABLE lending_controls
  ADD COLUMN IF NOT EXISTS write_off_requires_approval boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS loan_write_off_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id           uuid NOT NULL REFERENCES loan_accounts(id) ON DELETE CASCADE,
  reason            text NOT NULL CHECK (length(btrim(reason)) > 0),
  value_date        date NOT NULL,
  amount_at_request numeric(18,2) NOT NULL CHECK (amount_at_request > 0),
  status            text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  requested_by      text NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  decided_by        text,
  decided_at        timestamptz,
  decision_note     text,
  transaction_id    uuid REFERENCES transactions(id),
  CHECK ((status = 'PENDING') = (decided_by IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS loan_one_pending_write_off ON loan_write_off_requests (loan_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS loan_write_off_requests_status_idx ON loan_write_off_requests (status, requested_at);
CREATE INDEX IF NOT EXISTS loan_written_off_on_idx ON loan_accounts (written_off_on) WHERE status = 'CLOSED_WRITTEN_OFF';
