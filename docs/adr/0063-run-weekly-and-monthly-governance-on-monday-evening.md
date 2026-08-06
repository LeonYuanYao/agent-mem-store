---
status: accepted
---

# Run weekly and monthly governance on Monday evening

Governance uses an explicit IANA timezone initialized from the system timezone and kept stable until an authorized configuration change. Weekly Governance defaults to every Monday at 19:00. Monthly Governance defaults to the first Monday of each month at 19:00.

When Monthly and Weekly coincide, one Monthly Run executes the complete Weekly obligations and atomically satisfies both durable ledger obligations rather than calling Luna twice. A missed cadence is coalesced into one catch-up run from its last successful cursor instead of replaying every missed calendar occurrence.

Startup catch-up waits at least ten minutes and yields to foreground Hook or capture/index backlog. Only one deep governance run executes at a time, and ordinary capture and indexing take priority. Failure does not advance the successful cursor and follows the accepted retry and model-health policies.

Timezone, schedule, startup delay, and concurrency are explicitly configurable. Luna, metrics, and governance cannot silently modify them.
