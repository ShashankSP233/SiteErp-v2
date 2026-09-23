-- V6.1: Transfer movement type + PO attachment
ALTER TABLE transactions DROP CONSTRAINT transactions_transaction_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_transaction_type_check
  CHECK (transaction_type IN ('RECEIVED','ISSUED','RETURNED','DISCARD','ADJUSTMENT_IN','ADJUSTMENT_OUT','TRANSFER'));
ALTER TABLE purchase_orders ADD COLUMN attachment text;
