-- The long-term value judgment of each dream item (ADR-0177). Items judged low value
-- skip verification and are not written as Memory; NULL means not appraised (kept).
ALTER TABLE dream_items ADD COLUMN appraisal_json TEXT;
