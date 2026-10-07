# M3-PROTOCOL-V3 — Event-based pre-replan discrepancy

Protocol version: `M3-PROTOCOL-V3`
Manifest: `m3-manifest-v3`
Analysis: `m3-analysis-v3`
Summary: `m3-summary-v3`

This standalone offline analyzer supports **system V2 and system V3**. Protocol
version V3 is not the same thing as system version V3. It changes no runtime,
logging UI, M1/M2 instrumentation, routing, GPS, marker or Mapbox behavior.
The authoritative design is
`/Users/macbookpro/Documents/thesis/Next.js/summarize/M3_PRE_REPLAN_AUDIT_AND_PLAN.md`.

## Research definition

Immediately before each successful eligible frontend M1 replanning attempt
starts, how far is the current route's Target reference from the latest Target
position already known to Phone A?

At the **exact `m1_frontend_start` boundary**, freeze:

- `R`: previously accepted active route's Target reference coordinates,
  sample ID if available, and activation identity.
- `T`: latest preceding local `target_received` coordinates and sample ID.

```text
M3_i [m] = Haversine(R.target_reference, T.target_reference)
M1_i [ms] = SAME attempt's existing frontend duration_ms
identity = (system_version, research_run_id, session_id, route_update_id)
```

This is unsigned spatial discrepancy against **Agent-known Target state**.
It is not physical ground truth, distance traveled, signed along-route lag,
delivery latency, or proof of visible pixels. M3 zero is valid. Equal distances
from separate eligible attempts remain separate observations.

The current attempt's newly accepted route is validation evidence of success
and state for subsequent starts. It never replaces this attempt's old route.
Its request sample ID never replaces the latest received Target snapshot.

## Current M1 eligibility

### System V2

Only `normal` start/end pairs with `m1_frontend_end`, `m1_eligible=true`,
`success=true`, valid local duration and matching post-start `route_active`
are eligible. The activation sequence must match the terminal.
Initial and style-reload attempts are excluded. Explicit failure/unmount/abort,
missing source and no usable route outcomes remain diagnostics.

V2 can overlap requests and complete them in a different order. Pair by exact
identity, not adjacency. A normal successful duplicate geometry activation
remains eligible under its current contract. A pre-dispatch movement skip has
no M1 start and creates no observation.

Implementation boundary: `src/pages/navigation.tsx:354`, `:370`, `:389`, `:529`.

### System V3 / D-TANS

Snapshot **every** frontend M1 start before the update request. Its initial
`incremental` label is provisional. Promote later only for a true/true
incremental `m1_frontend_end` with the same run/session/update identity and
matching accepted stable `route_active` after start and before terminal.
Activation request phase must be incremental; terminal route version must match.

`/init`, first-route responses, graph refetch/rebuild, fallback, blocked,
no-change/duplicate/agent-only trim, stale, superseded, presentation-held,
aborted, API/network/rate-limit failure and invalid responses are excluded.
An incomplete chain invalidates the run; it is not an assumed failed attempt.

Backend success or `route_frontend_accepted` alone is insufficient. Explicit
same-attempt refetch/physical Mapbox evidence contradicting an eligible
incremental terminal fails validation rather than silently changing eligibility.

Implementation boundaries: `src/hooks/useNavigation.tsx:685`, `:735`, `:829`,
`:861`, `:926`; `src/pages/navigation.tsx:1024`; `src/lib/research/m1Frontend.ts:67`.

V3's logical stable source acceptance is the existing M1 boundary. It precedes
the separate imperative renderer path (`src/pages/navigation.tsx:1373`).
M3 adds no M5/video/renderer-completion requirement. V2 and V3 frontend M1
durations span different system processes; describe both boundaries in results,
not as identical isolated algorithm execution times.

## Causal event selection and state machine

Read the Navigation export in recorded order. Never repair it by sorting.
Require unique positive integer `event_seq`, consecutive accepted records from
run start, correct system/run identity, one selected continuous Navigation
session, one start/stop boundary and final logger health.

Canonical M3 clock is raw finite `mono_ms` on local primary events:
`run_start`, `target_received`, `route_active`, M1 starts/terminals, `run_stop`.
Validate nondecreasing primary time. For reference `E` and start `S`:

```text
E.event_seq < S.event_seq
E.mono_ms <= S.mono_ms
```

Equal timestamps are processed one event at a time. Lower sequence is already
known; higher sequence is future evidence. Do not group all equal-time events
before processing a start. Never use nearest timestamps, wall-clock matching,
Sender/server clock subtraction or future state.

1. Every local `route_active` validates identity/coordinates and updates route
   state, including excluded initial/style/refetch/fallback activations.
2. Every local `target_received` updates receipt state, including repeated
   identical samples. No freshness rejection applies.
3. Every M1 start records an immutable snapshot. Input events are copied before
   analysis; later state transitions cannot mutate a snapshot.
4. Match terminal by the complete identity tuple. Check start, terminal, new
   activation ordering and identity. Non-null request sample IDs must agree.
5. Only eligible successful terminal claims yield successful candidate rows.
   Calculate from the frozen old route/receipt or retain `M3_UNAVAILABLE`.

Invalid current state is retained as invalid state: never search backward to
replace it with an older good route/receipt. Do not cross a run/session reset,
page reload or re-init inside the claimed continuous run. Receipts ordinarily
lack session ID; scope them to the explicit single Navigation run/session and
validate any session field if present.

### V3 microsecond representation

When present, `monotonic_us` must be a safe nonnegative integer. On local M3
primary events that share one capture instant with `mono_ms`, also require:

```text
monotonic_us = max(0, round((mono_ms - run_start.mono_ms) * 1000))
```

This is the current logger representation, not a research threshold. Missing
raw primary `mono_ms` is invalid: no relative-microsecond fallback. Optional
absent `monotonic_us` is not a new runtime requirement.

Hot diagnostics may lack raw `mono_ms`; final export health captures its us and
raw mono separately (`src/lib/research/provenanceEvents.ts:510`). Do not force
these diagnostics into exact equality against a different capture instant.
They do not select M3 state. Backend imports retain independent backend clocks;
their local import timing never becomes primary receipt/activation evidence.
They can arrive after stop before final health without extending the run.

M1 duration validation retains the existing validator's 0.001 ms numeric
serialization tolerance (`scripts/validate-m1-jsonl.mjs:65`). This is not a
latency/freshness/quality cutoff or a way to select observations.

## Provenance and optional Sender evidence

Primary arithmetic uses Navigation coordinates. Sample IDs are optional;
never fabricate them. A missing ID yields `NAV_COORDINATES_ONLY`, not zero or
automatic rejection when all required coordinate/identity evidence is valid.
Conforming `<Sender UUID>:T<zero-padded sequence>` IDs expose parsed session
and sequence. Opaque IDs are preserved with unparsed-identity diagnostics.

Sender JSONL may supply external exact reference attestation and GPS diagnostics:

| Status | Meaning |
|---|---|
| `TRACE_NOT_SUPPLIED` | No optional trace; coordinate pair can remain valid |
| `TRACE_REFERENCE_NOT_FOUND` | Supplied trace lacks this ID; attestation incomplete |
| `TRACE_VERIFIED` | Exact sample identity and coordinates agree |
| `TRACE_COORDINATE_CONTRADICTION` | Trace and claimed Navigation coordinates disagree; invalid |
| `TRACE_AMBIGUOUS` | Conflicting/invalid trace identity cannot attest reference; invalid |
| `NAV_COORDINATES_ONLY` | Sample ID null; coordinates retained honestly |
| `MISSING_REFERENCE` | Required Navigation state absent; unavailable |

Validate supplied trace sample ID/session/sequence and coordinate ranges.
Contradictory duplicate trace coordinates or GPS evidence invalidate the run;
identical duplicate attestations are reported without choosing different evidence.
Same claimed sample ID with different Navigation coordinates is invalid.

The optional `intended_current_sender_session_ids` explicitly binds current
Sender identity evidence. A latest receipt from another known session is
invalid. Null/unparsed IDs are unattested, not invented matches. Legitimate
Sender restarts must be declared consistently before analysis.

The **previous route** may legitimately refer to an older Sender session for
the same configured Target. Preserve and flag `OLD_ROUTE_DIFFERENT_SENDER_SESSION`;
missing old-session trace does not remove a real pre-replan pair or allow using
the new route. Known wrong Navigation identity or contradictory Target evidence
still invalidates the run. JSONL coordinate evidence does not independently
identify a physical person; session/Target binding must reflect the field setup.

GPS accuracy, speed and source timestamps are diagnostics only. Receipt age and
first-seen age use Phone-A time only. First-seen is maintained per non-null ID;
repeated receipts do not reset it. Older samples returning remain latest receipt
state and are flagged diagnostically, with no discretionary rejection.

## Completeness and official statistics

```text
Ns = successful_eligible_M1_count (each claimed successful terminal retained)
Np = official_paired_M3_count (otherwise valid pairs, even in an invalid run)
Nu = m3_unavailable_count
pairing_complete = (Ns == Np && Nu == 0 && no structural/health errors)
```

Each `m1_frontend_end` is a success claim. A malformed end or true success flags
on an incorrectly named outcome remain visible in Ns and receive validation
reasons, not silent denominator removal. Duplicate success terminals retain
every claim and invalidate the run. Missing start/activation and incomplete
chains fail closed. Excluded false/false outcomes remain separate diagnostics.

Require final `logger_health` with a usable integer drop count. Any reported
drop, sequence corruption or absent/unusable final health invalidates official
M3. V2 drops can occur without sequence gaps; health is required independently.

| Situation | Result |
|---|---|
| Complete, Ns > 0 | `VALID`; all pairs official |
| Ns > 0, missing pair | `INVALID`; keep unavailable candidate/reasons; official numeric statistics null |
| Other structural/health contradiction | `INVALID` even if Ns == Np |
| Structurally complete, Ns = 0 | `NO_ELIGIBLE_REPLANS`; count 0, numeric statistics null |

Example: Ns 30 / Np 29 / Nu 1 => INVALID. No official mean of only 29 pairs.
Np is a completeness count, not approval of partial results. An invalid run has
no `official_observations`; pairable rows are under `diagnostic_only` only.
Missing values are never zero, guessed, backfilled or silently omitted.

For approved complete runs: arithmetic mean; median at p=0.5; P95 at p=0.95,
using sorted linear interpolation `h=(n−1)*p`; min/max are extremes. One value
gives that value for every statistic. Invalid numeric values are rejected, not
filtered/coerced. Statistics retain full precision; display rounding is external.

## Manifest and CLI

Copy `scripts/m3-v3-manifest.template.json` to a separate manifest for each run.
Replace all placeholders with exact raw Navigation identities; choose V2 or V3.
The CLI refuses placeholders and unknown/legacy fields. No criteria file exists.

```json
{
  "schema_version": "m3-manifest-v3",
  "protocol_version": "M3-PROTOCOL-V3",
  "system_version": "V2",
  "navigation": {
    "file": "./MAIN_V2_R1_NAVIGATION.jsonl",
    "research_run_id": "<copy exact research_run_id from the export>",
    "session_id": "<copy exact Navigation session_id from the export>",
    "sha256": null
  },
  "sender": {
    "file": null,
    "sha256": null,
    "intended_current_sender_session_ids": []
  }
}
```

This is a placeholder example, not actual Main data. For V3 use `"V3"` and
its own export/bindings. Sender may be omitted/null; or provide `file`, optional
hash, and optional intended UUID list. A Sender identity list can be supplied
with no trace file. Relative paths resolve against the manifest directory.
Files must be distinct. Explicit lowercase SHA-256 mismatch is a configuration
failure; actual input hashes and real paths are always returned. Raw labels
are preserved; file matching is never inferred from labels or proximity.

From `/Users/macbookpro/Documents/thesis/maps/research/AFE_Plus_V3_Research`:

```sh
# Future Main V2 run, after its explicit manifest has been filled
node scripts/analyze-m3-v3.mjs --manifest /absolute/path/to/MAIN_V2_R1.manifest.json

# Future Main V3 run, after its explicit manifest has been filled
node scripts/analyze-m3-v3.mjs --manifest /absolute/path/to/MAIN_V3_R1.manifest.json

# Optional human-readable row table goes to stderr
node scripts/analyze-m3-v3.mjs --manifest /absolute/path/to/run.manifest.json --table

# Deterministic synthetic verification
node scripts/verify-m3-v3-analyzer.mjs
```

JSON only on stdout; human summary/table on stderr. Supported arguments are
`--manifest <file>` and optional `--table`; other arguments return exit 2.
No analyzer file writes occur.
If redirecting stdout, choose a new output file and never a raw input path.

| Exit | Exact behavior |
|---:|---|
| 0 | Valid complete official numeric result |
| 1 | INVALID run, NO_ELIGIBLE_REPLANS, or unexpected analyzer error with no official result |
| 2 | Usage/manifest/input binding/read/hash configuration error |

Malformed Navigation/Sender JSONL yields an INVALID run result, not a repaired
stream. Configuration errors also produce a JSON error envelope with null
official statistics; no automatic V1/V2 migration is attempted.

## Output schema

Top level: `schema_version`, `protocol_version`, `summary`,
`official_observations`, `unavailable_successful_candidates`, `diagnostic_only`.

Each successful candidate includes:

- Protocol/system/run/session, replan index and update UUID.
- Start seq/raw mono/optional us, terminal seq/status and M1 duration.
- Previous route event/update ID, activation sequence, optional version/signature,
  sample ID and exact Target latitude/longitude.
- Latest receipt event seq/time, sample ID and exact Target latitude/longitude.
- `m3_pre_replan_distance_m`, `PAIRED` or `M3_UNAVAILABLE`, all unavailable reasons.
- Separate route/receipt provenance statuses, parsed Sender sessions and GPS
  diagnostics, duplicate trace counts and warnings.
- Receipt age, first-seen/age, repeated-sample and sequence-regression diagnostics.
- New activation identity for validation only.

Summary includes Ns/Np/Nu, completeness/status, unavailable and excluded counts
by reason, approved distribution, repeated receipt count, final/drop health
evidence, explicit file paths/hashes/bindings and warnings. Invalid-run otherwise
paired candidates are kept exclusively in the `DIAGNOSTIC_ONLY` block. No
partial distribution is presented as official. Config-error envelopes contain
error text and null statistics but no reconstructed observations.

## Main field procedure

Plan: **3 V2 + 3 V3 Main rounds, approximately 300 m Target movement per round**.
Use comparable route/conditions and distinct complete run/session exports.

- M1: all successful eligible frontend replans; report each system's boundary.
- M2: actual cumulative Directions requests at 0/50/100/150/200/300 m.
- M3: one frozen pre-replan discrepancy per eligible successful M1; no checkpoints.

Use existing START/STOP/EXPORT controls. Record before initialization and Target
receipt where the current UI permits. Use a fresh uninterrupted Navigation
session; do not reset/re-init mid-run. STOP before closing/exporting. Preserve
Sender trace for provenance/diagnostics if available.

Before Main, check a manual dry-run export for actual preceding route and receipt
at every eligible start and usable final health. START before init alone does
not prove Target receipt logging: initial Target state can predate recording.
Missing evidence is a failed completeness check, never a warm-up cutoff or
future-sample backfill. No new logging action/timer/calibration is required.
This analyzer does not certify physical route length, deployed build, GPS ground
truth, rendered pixels or M2 checkpoint procedure.

## Historical protocols preserved

M3-PROTOCOL-V1/V2 analyzers, tests, templates, summaries and calibration files
remain unchanged. No time grid, observation interval, freshness/GPS/speed cutoff,
startup duration, linkage-ready grid cutoff, calibration walk, cumulative GPS,
cross-device clock alignment or distance checkpoint selects new M3 observations.
The unchanged `scripts/m3-haversine.mjs` is the only shared calculation helper;
it uses `{lat,lng}`, finite/range validation, Earth radius 6,371,000 m and returns
meters. No new package dependency is required.
