---
status: accepted
---

# Keep the proxied Jev connection warm while a Session is active

Jev rejects some regions (HTTP 451), so its requests go through a local HTTP
proxy (`[jev].proxy`). A request on an open connection through the proxy took
about 150-550 ms; opening one, with a TLS handshake through the tunnel, took
0.5-1 s and sometimes exceeded the 1.3 s Jev budget. Claude Code leaves Jev
about 0.8-1.2 s. Prompts usually come minutes apart and the pool closed idle
connections after 60 s, so most prompts opened a new one. On 2026-10-21 new
connections timed out in 2 of 5 trials, while reused ones did not.

Decision: the Worker keeps the proxied connection open while agent Sessions
are in use.

- Any foreground message (a prompt, a cleared conversation at a Session
  boundary, an assistant reply) marks activity. A cleared conversation also
  opens the connection at once, since a prompt usually follows; a prompt opens
  it itself.
- For 30 minutes after the last activity the connection is used at least every
  180 s. If no Jev request did so, the Worker sends `GET /cdn-cgi/trace` to the
  Jev host: free, unauthenticated, with no prompt, Memory or credential. After
  30 minutes without activity nothing is sent.
- Idle connections close after 240 s. Through the proxy in use, idle
  connections were still reusable after 60, 150 and 300 s and closed by 600 s
  (2026-10-21), so the pool never keeps a connection the far side may have dropped.
- The far side also closed some idle connections after 45-100 s. The pool is
  checked every 15 s, locally, and a closed connection is reopened at once; after
  a failed attempt the next one waits 180 s.
- A Jev request that times out or fails on the network, or a failed warm-up,
  closes the idle connections, so a silently dropped connection cannot stall the
  next request. Requests in flight keep theirs.
- Only the proxy path is warmed. Without a proxy Node's fetch keeps connections
  a few seconds, and warming would only add requests.

Rejected: a longer Jev timeout (the foreground budget, not Jev's, is the limit);
warming continuously (requests while no agent is used); a warm-up before every
prompt (it would race the request it is meant to speed up).
