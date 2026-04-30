# PLAN-0008 — Link every claimed mitigation to a test or inline assertion

- **Status:** Planned
- **Type:** Documentation + targeted test additions

## Gap

THREAT_MODEL.md and the ADRs make behavioral claims that an external reviewer cannot verify without reading the code. Some claims cite a test file (ADR-0004 cites `src/__tests__/tools/setup.test.ts` for `klodi_setup_repair` narrow-blast-radius — the right pattern). Most do not. Examples of unverified claims:

- "Malformed frames are logged-and-dropped, never executed" (ADR-0001 / `parseWireEvent`). No test cited.
- "`writeFileSync(..., { mode: 0o600 })` *and* explicit `chmodSync(path, 0o600)`" (ADR-0002, T8). The code does this, but no test asserts the resulting mode on disk.
- "`OFFERS_CACHE_TTL_MS = 30_000` deduplicates… one concurrent burst produces one request, not N" (ADR-0007). No test cited.
- "`clearAllTimers()` runs at service `stop()`" (ADR-0007). Service-lifecycle test reference missing.
- "Mode drift warning" at read time (ADR-0002, T8). No test cited.

## Proposed approach

Two-step, done together so the docs don't drift while adding tests:

1. **For every behavioral claim in an ADR or THREAT_MODEL row**, either:
   - Cite an existing test at `src/__tests__/…#test-name`, or
   - Add a small targeted test, then cite it, or
   - Mark the claim as "observed in code at `path:line`" when a test is not meaningful (e.g. "connection goes to one host" is obvious-from-code).
2. **Audit the ADRs and THREAT_MODEL in one pass**; commit the test additions and the citation updates together.

## Why deferred

Mechanical work. Low risk, medium tedium. Best done once, thoroughly, rather than piecemeal.

## Definition of done

- Every mitigation bullet in THREAT_MODEL.md ends in either a `src/__tests__/…` reference or a `src/…:line` reference.
- Every "Security implications" bullet in each ADR does the same.
- New tests added in the same PR as the citation updates so CI proves the claim.
