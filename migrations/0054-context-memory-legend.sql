ALTER TABLE context_epochs
  ADD COLUMN memory_legend_version INTEGER NOT NULL DEFAULT 0
    CHECK (memory_legend_version >= 0);
