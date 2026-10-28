-- Two layers for dreaming Memory (ADR-0155): besides the one-sentence statement,
-- extraction may keep the steps, commands, values or criteria the statement
-- cannot hold. The item carries the longest member detail; apply writes it into
-- the Memory body while the statement stays the compact representation.
ALTER TABLE dream_candidates ADD COLUMN detail TEXT;
ALTER TABLE dream_items ADD COLUMN detail TEXT;
