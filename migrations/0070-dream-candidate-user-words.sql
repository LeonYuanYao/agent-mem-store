-- A candidate the extractor marks as stated by the user keeps the user message(s)
-- its quote came from (JSON array), so verification can tell the user's own rule
-- from a pasted task description. NULL when the candidate is not user-stated.
ALTER TABLE dream_candidates ADD COLUMN user_words_json TEXT;
