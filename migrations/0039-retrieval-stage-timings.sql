ALTER TABLE retrieval_receipts
ADD COLUMN timing_json TEXT NOT NULL DEFAULT '{}';
