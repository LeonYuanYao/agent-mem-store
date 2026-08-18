UPDATE memory_candidates AS candidate
SET successful_evaluation_at = NULL
WHERE candidate.state = 'waiting'
  AND candidate.successful_evaluation_at IS NOT NULL
  AND (
    SELECT decision.reason
    FROM governance_decisions AS decision
    WHERE decision.candidate_id = candidate.candidate_id
    ORDER BY decision.decided_at DESC, decision.decision_id DESC
    LIMIT 1
  ) = 'insufficient_evidence'
  AND EXISTS (
    SELECT 1
    FROM candidate_evidence AS evidence
    JOIN capture_events AS capture ON capture.event_id = evidence.evidence_id
    WHERE evidence.candidate_id = candidate.candidate_id
      AND evidence.evidence_class = 'command_outcome'
      AND evidence.integrity = 'intact'
      AND evidence.source_truncated = 0
      AND evidence.memory_echo = 0
      AND evidence.evidence_content_identity IS NOT NULL
      AND capture.event_kind = 'PostToolUse'
      AND capture.source_truncated = 0
      AND capture.whole_content_sha256 = evidence.evidence_content_identity
      AND capture.occurred_at = evidence.occurred_at
      AND evidence.source_identity =
        capture.agent || ':' || COALESCE(capture.session_id, 'unknown') || ':' ||
        COALESCE(capture.turn_id, capture.event_id)
      AND NOT (
        evidence.command_text IS NOT NULL
        AND length(evidence.command_text) > 0
        AND evidence.command_cwd IS NOT NULL
        AND evidence.command_cwd LIKE '/%'
        AND evidence.command_exit_code IS NOT NULL
        AND evidence.command_result_identity IS NOT NULL
      )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM semantic_assessments AS assessment
    WHERE assessment.candidate_id = candidate.candidate_id
      AND assessment.evidence_generation = candidate.evidence_generation
  );
