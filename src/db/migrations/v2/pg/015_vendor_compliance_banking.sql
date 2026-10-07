ALTER TABLE vendors
    ADD COLUMN IF NOT EXISTS gst_no                TEXT,
    ADD COLUMN IF NOT EXISTS gst_certificate_file  TEXT,
    ADD COLUMN IF NOT EXISTS pan_no                TEXT,
    ADD COLUMN IF NOT EXISTS pan_certificate_file  TEXT,
    ADD COLUMN IF NOT EXISTS udyam_id              TEXT,
    ADD COLUMN IF NOT EXISTS bank_account_no       TEXT,
    ADD COLUMN IF NOT EXISTS bank_name             TEXT,
    ADD COLUMN IF NOT EXISTS ifsc_code             TEXT,
    ADD COLUMN IF NOT EXISTS cancelled_cheque_file TEXT;

UPDATE vendors
   SET gst_no = UPPER(BTRIM(tax_identifier))
 WHERE gst_no IS NULL
   AND UPPER(BTRIM(tax_identifier)) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$';

UPDATE vendors
   SET pan_no = UPPER(BTRIM(tax_identifier))
 WHERE pan_no IS NULL
   AND gst_no IS NULL
   AND UPPER(BTRIM(tax_identifier)) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$';

CREATE INDEX IF NOT EXISTS idx_vendors_gst_no ON vendors(gst_no);
CREATE INDEX IF NOT EXISTS idx_vendors_pan_no ON vendors(pan_no);