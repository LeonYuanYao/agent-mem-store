export const connectionRecoveryCooldownMilliseconds = 6 * 60 * 60 * 1_000;
export const maximumConnectionRecoveryAttempts = 2;

// Shared by the queue and doctor; this is static SQL, never user input.
export const connectionRecoveryCandidateSql = `
  state = 'blocked'
  AND epoch_attempt_count >= 7
  AND last_error_category IN ('timeout', 'unavailable', 'rate_limited')
  AND connection_recovery_count < ${String(maximumConnectionRecoveryAttempts)}
`;
