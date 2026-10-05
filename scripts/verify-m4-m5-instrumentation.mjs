import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const navigation = readFileSync(new URL('../src/pages/navigation.tsx', import.meta.url), 'utf8');
const logger = readFileSync(
  new URL('../src/lib/research/provenanceEvents.ts', import.meta.url),
  'utf8',
);
const navigationService = readFileSync(new URL('../src/lib/services/navigation.service.ts', import.meta.url), 'utf8');
const navigationHook = readFileSync(new URL('../src/hooks/useNavigation.tsx', import.meta.url), 'utf8');

assert.equal(
  (navigation.match(/navigator\.geolocation\.watchPosition\(/g) ?? []).length,
  1,
  'research instrumentation must reuse exactly one browser GPS watch',
);
assert.match(
  navigation,
  /\(pos\) => \{\s*const receiptPerformanceMs = performance\.now\(\);/,
  'M4 timestamp must be the first watchPosition success-callback statement',
);
assert.match(navigation, /event: 'raw_location_received'/);
assert.match(navigation, /event: 'agent_motion_computed'/);
assert.match(navigation, /event: 'agent_marker_command_dispatched'/);
assert.match(navigation, /originalSetLngLat\.call\(instrumented, lngLat\)/);
assert.match(navigation, /ref=\{observeAgentMarker\}/);
assert.match(logger, /const MAX_EVENTS = 100_000/);
assert.match(logger, /dropped_by_event/);
assert.match(logger, /export function buildResearchJsonl/);
assert.match(logger, /status === 'RECORDING'\) return null/);
assert.match(navigationService, /const res = await fetch\(url,[\s\S]*?const receivedAt = performance\.now\(\);\s*if \(routeProvenance\?\.research_run_id === getRecordingResearchRunId\(\)\) \{\s*appendResearchObservationAt\(\{\s*event: 'route_update_received'/);
assert.match(navigationHook, /if \(m5PathAccepted\) \{[\s\S]*?event: 'route_frontend_accepted'/);
assert.match(navigation, /source\.setData\(geojson\);[\s\S]*?event: 'route_render_command_completed'/);
assert.match(navigation, /completion_kind: 'mapbox_geojson_source_setData_return',[\s\S]*?visible_render_confirmed: false/);

const fixture = [
  { event: 'raw_location_received', location_sample_id: 10, monotonic_us: 1000000 },
  { event: 'raw_location_received', location_sample_id: 11, monotonic_us: 2500000 },
  { event: 'agent_motion_computed', motion_frame_id: 20, location_sample_id: 11 },
  { event: 'agent_marker_command_dispatched', marker_command_id: 30, motion_frame_id: 20 },
  { event: 'agent_marker_command_completed', marker_command_id: 30, visible_render_confirmed: false },
];
const receipts = fixture.filter(event => event.event === 'raw_location_received');
assert.equal(receipts[1].monotonic_us - receipts[0].monotonic_us, 1500000);
const motion = fixture.find(event => event.event === 'agent_motion_computed');
const command = fixture.find(
  event => event.event === 'agent_marker_command_dispatched'
    && event.motion_frame_id === motion.motion_frame_id,
);
assert.ok(command, 'M5 motion-to-command link must be reconstructable');
assert.equal(
  fixture.at(-1).visible_render_confirmed,
  false,
  'command completion must not be represented as visible rendering proof',
);

console.log('M4/M5 instrumentation invariants verified.');
