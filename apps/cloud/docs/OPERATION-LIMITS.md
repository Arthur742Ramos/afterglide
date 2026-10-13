# Cancellation and operation limits

Cloud requests carry a main-process abort signal and an absolute deadline. The
same deadline covers fetching headers, reading the body, retry backoff and later
polls. Read-only requests can retry transient failures; session creation remains
single-attempt. Each request's complete retry budget is at most 12 seconds, or
15 seconds for catalog requests, and is shortened by its parent deadline.

Catalog hydration has a 90-second total budget and retains four worker slots.
Search has a 30-second budget, at most 32 pages and 10,000 accumulated products.
A bounded search that cannot finish asks for a more specific query.
Search metadata retained between queries is restricted to product IDs in the
authenticated cloud library and pruned when that library changes. Full session
provisioning, including token refresh and creation, has a 180-second deadline.
SDP and ICE exchanges each have a 20-second total budget including their POST.
These are client limits, not Xbox service or latency guarantees.

Sign-out and account changes abort discovery and search. Editing or clearing a
query, leaving the library, or starting a newer search aborts the obsolete search
through the trusted preload bridge. Cancelling a launch releases its owner
immediately; an older completion cannot release a newer launch's owner.
Stopping a session aborts its pending negotiation and keepalive requests.

Late creation replies receive best-effort cleanup with their captured service
credentials. Cleanup skips a path already used by a newer active session or one
that may belong to a newer unresolved creation. If Xbox accepted creation but
the client never receives its session path, the client cannot safely identify
that remote session for deletion. It does not retry creation or guess a path.

The bundled authentication SDK has no transport abort API. Cancellation and
deadlines release Afterglide's waits and preserve credential ownership; an
already-running SDK request or device-code poll can continue until the SDK
finishes. This change does not replace its authentication protocol.

Regression tests use simulated HTTP, fake clocks and platform adapters. Real
Xbox interruption, network changes and long-running recovery still need live
validation on Windows and macOS.
