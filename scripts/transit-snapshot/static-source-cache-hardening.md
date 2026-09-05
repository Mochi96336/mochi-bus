# Static source cache safety contract

Fresh TDX static payloads are not durable cache authority merely because the HTTP request succeeded.

- Full City and InterCity payloads are first written as content-addressed R2 candidates.
- Malformed, empty, or structurally unusable payloads are never staged.
- Changed candidates are promoted to `state.json` only after the snapshot model passes local validation.
- An UpdateTime-only refresh may promote immediately when its non-volatile semantic hash matches the already-promoted payload.
- The old content-addressed payload is deleted only after the new `state.json` commit succeeds.
- Static-cache R2 requests have a finite timeout and remain fail-open for snapshot fetching.
- Fresh InterCity candidates never enter the cross-process workflow cache before promotion.
