---
status: accepted
---

# Block structured Secrets and quarantine contextual uncertainty

The first-version local detector directly classifies high-confidence structured credentials. Covered classes include PEM private keys, authorization or bearer headers, session cookies, provider token formats with stable structure, service-account private-key fields, and non-empty values bound to credential field names in supported text or structured data.

Generic high-entropy text is not sufficient by itself to classify Secret. Entropy combined with authentication or credential context but without enough evidence for direct classification enters the accepted body-free Sensitivity Quarantine. Known benign hashes, UUIDs, commit identities, public keys, file paths, and explicit test placeholders receive negative regression coverage to control false positives.

Neither Secret nor Quarantined suspect content is sent to Luna. False-positive Override remains bound to the exact fingerprint, detector rule and version, and content revision.

Before Full Cutover, synthetic credentials and representative non-Secret samples must prove direct classification, quarantine, exact override, revision invalidation, and absence of original values from Outbox, SQLite, Vault-derived files, indexes, embeddings, Injection Receipts, logs, Review Inbox, and notifications.
