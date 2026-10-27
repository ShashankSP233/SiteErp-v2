ALTER TABLE stock_transfer_items
ADD COLUMN IF NOT EXISTS receiver_notes TEXT;
