UPDATE luna_operations
SET epoch_attempt_count = attempt_count
WHERE retry_epoch = 0
  AND epoch_attempt_count = 0
  AND attempt_count > 0;
