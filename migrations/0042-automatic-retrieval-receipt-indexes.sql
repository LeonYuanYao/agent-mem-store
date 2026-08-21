CREATE INDEX retrieval_receipts_epoch
  ON retrieval_receipts(epoch_id, receipt_id)
  WHERE epoch_id IS NOT NULL;

CREATE INDEX retrieval_receipt_items_receipt_outcome
  ON retrieval_receipt_items(receipt_id, outcome, memory_id, revision_id);
