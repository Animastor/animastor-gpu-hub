# Changelog

## Unreleased

### Fixed

- `gpu-hub.js` — `POST /beacon` (protocol 2 tick) and `POST /v3/beacon` share
  the heartbeat key `animastor:worker:heartbeat:{type}:{id}` and both rewrote
  it whole, so the v2 tick erased `protocol_version: 3` / `current_job_id`
  left by the v3 tick (reports/2026-11-06 §10). A v2 write now merges those
  two fields from a v3 record younger than the key's 30 s TTL; TTL and every
  other field stay as before. A worker with only the v2 beacon writes the key
  exactly as it did.
