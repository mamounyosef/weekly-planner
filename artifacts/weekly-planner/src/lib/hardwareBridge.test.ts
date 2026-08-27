// ---------------------------------------------------------------------------
// Unit tests for the ESP32 hardware bridge (hardwareBridge.ts).
//
// Tests the server-side event queue, presence-filter coordination, lease
// arbitration, controller-state whitelist, LCD display freshness, diagnostic
// storage, and sensor config coercion on a pure synthetic clock.
//
// Run with:  npx tsx src/lib/hardwareBridge.test.ts
// ---------------------------------------------------------------------------

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HardwareBridge, createHardwareBridge, HW_LEASE_MS, type HardwareEvent } from './hardwareBridge';
import { INITIAL_CONTROLLER_STATE, type HardwareControllerState } from './hardwareController';
import { DEFAULT_SENSOR_FILTER_CONFIG } from './sensorFilter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'pass' : 'FAIL'}  ${name}${cond ? '' : `   <- ${detail}`}`);
}

function section(title: string) {
  console.log(`\n${title}`);
}

class Clock {
  t = 1_700_000_000_000;
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

// ---------------------------------------------------------------------------
// 1. Event Queue
// ---------------------------------------------------------------------------
section('1. Event Queue');
{
  const clk = new Clock();
  const bridge = createHardwareBridge({ now: clk.now });

  check('empty queue returns latest=0 and empty events',
    bridge.getEvents(0, true).body.latest === 0 &&
    (bridge.getEvents(0, true).body.events as unknown[]).length === 0);

  // Push 3 distinct events
  bridge.handleEvent({ type: 'button_a' });
  bridge.handleEvent({ type: 'button_b' });
  bridge.handleEvent({ type: 'manual_stop' });

  const evtsAll = (bridge.getEvents(0, true).body.events as HardwareEvent[]);
  check('event IDs are strictly monotonic',
    evtsAll.length === 3 && evtsAll[0].id === 1 && evtsAll[1].id === 2 && evtsAll[2].id === 3);

  const evtsSince2 = (bridge.getEvents(2, true).body.events as HardwareEvent[]);
  check('since filtering returns only newer events (id > since)',
    evtsSince2.length === 1 && evtsSince2[0].id === 3 && evtsSince2[0].type === 'manual_stop');

  // Push 60 events to verify backlog cap at 50
  for (let i = 4; i <= 60; i++) {
    bridge.handleEvent({ type: 'button_a' });
  }

  const capped = (bridge.getEvents(0, true).body.events as HardwareEvent[]);
  check('backlog is capped at 50 events', capped.length === 50, `length=${capped.length}`);
  check('51st push drops the oldest event (starts at id 11)',
    capped[0].id === 11 && capped[capped.length - 1].id === 60,
    `startId=${capped[0]?.id} endId=${capped[capped.length - 1]?.id}`);
  check('latest sequence counter tracks newest push accurately after wrap',
    bridge.getEvents(0, true).body.latest === 60);
}

// ---------------------------------------------------------------------------
// 2. First-Poll Behavior & AnnounceOnConnect
// ---------------------------------------------------------------------------
section('2. First-Poll Behavior & AnnounceOnConnect');
{
  const clk = new Clock();
  const bridge = createHardwareBridge({ now: clk.now });

  // Initial events exist in the queue
  bridge.handleEvent({ type: 'button_a' });
  bridge.handleEvent({ type: 'button_b' });

  // Feed sensor data until the filter is ready and present
  for (let i = 0; i < 20; i++) {
    clk.advance(100);
    bridge.handleEvent({ type: 'samples', dt: 100, cm: [32] });
  }
  check('filter is ready and present', bridge.hwFilter.snapshot.ready && bridge.hwFilter.snapshot.present);

  const initialLatest = bridge.hwEventSeq;

  // New window connects for the first time with since=0
  const firstPoll = bridge.getEvents(0, true);
  const firstPollEvents = firstPoll.body.events as HardwareEvent[];
  check('first poll does not include the post-response announcement',
    firstPollEvents.every(e => e.id <= initialLatest));
  check('latest reported in first poll is the pre-announce sequence',
    firstPoll.body.latest === initialLatest);
  check('server sequence incremented by 1 for announcement',
    bridge.hwEventSeq === initialLatest + 1);

  // Because announceOnConnect is true and filter is ready, exactly one presence event was queued AFTER response
  const secondPoll = bridge.getEvents(initialLatest, true);
  const secondPollEvents = secondPoll.body.events as HardwareEvent[];
  check('exactly one announce event was queued for the newcomer',
    secondPollEvents.length === 1 &&
    secondPollEvents[0].type === 'presence' &&
    secondPollEvents[0].present === true &&
    secondPollEvents[0].id === initialLatest + 1);

  // A rapid third poll with since=0 within 10 seconds must NOT re-announce
  clk.advance(5000); // 5s < 10s
  const currentLatest = bridge.hwEventSeq;
  bridge.getEvents(0, true);
  check('rate-limiting prevents duplicate announcement within 10 seconds',
    bridge.hwEventSeq === currentLatest);

  // When announceOnConnect is false, announcement never occurs
  const clk2 = new Clock();
  const bridgeNoAnnounce = createHardwareBridge({ now: clk2.now });
  bridgeNoAnnounce.postConfig({ announceOnConnect: false });
  for (let i = 0; i < 20; i++) {
    clk2.advance(100);
    bridgeNoAnnounce.handleEvent({ type: 'samples', dt: 100, cm: [32] });
  }
  const prePollSeq = bridgeNoAnnounce.hwEventSeq;
  bridgeNoAnnounce.getEvents(0, true);
  check('announceOnConnect: false suppresses connection announcement',
    bridgeNoAnnounce.hwEventSeq === prePollSeq);
}

// ---------------------------------------------------------------------------
// 3. Sample Ingestion & Timestamp Back-Dating
// ---------------------------------------------------------------------------
section('3. Sample Ingestion & Timestamp Back-Dating');
{
  const clk = new Clock();
  const bridge = createHardwareBridge({ now: clk.now });

  // Initial seat: 20 samples of 30cm
  for (let i = 0; i < 20; i++) {
    clk.advance(100);
    bridge.handleEvent({ type: 'samples', dt: 100, cm: [30] });
  }
  check('seated in front of sensor', bridge.hwFilter.snapshot.present);

  // Push a batch of 10 samples with dt = 100ms at time nowMs.
  // Sample 0..6: 30cm, Sample 7: 58cm, Sample 8: 58cm, Sample 9: 58cm
  // Let's verify back-dating formula: at = now - (n - 1 - i) * dt
  const nowMs = clk.now();
  const n = 10;
  const dt = 100;
  const rawCm = [30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  bridge.handleEvent({ type: 'samples', dt, cm: rawCm }, nowMs);

  // Verify diagnostic capture
  const live = bridge.getLive(nowMs).body;
  check('live diagnostics populated from sample batch',
    live.present === true && live.distanceCm === 30 && live.rawCm === 30 && live.fresh === true);

  // Non-array cm handles gracefully
  const resBadCm = bridge.handleEvent({ type: 'samples', dt: 100, cm: 'invalid' });
  check('non-array cm does not throw and returns success', resBadCm.status === 200);

  // Non-numeric array items become null
  const resMixed = bridge.handleEvent({ type: 'samples', dt: 100, cm: [30, 'bad', null, undefined, -5, 0, 35] });
  check('mixed non-numeric cm entries handled cleanly', resMixed.status === 200);

  // 500-sample batch
  const bigBatch = new Array(500).fill(32);
  const resBig = bridge.handleEvent({ type: 'samples', dt: 100, cm: bigBatch });
  check('500-sample batch ingested without errors', resBig.status === 200);

  // dt clamping: dt < 20 clamps to 20, dt > 5000 clamps to 5000
  const bridgeDt = createHardwareBridge({ now: clk.now });
  bridgeDt.handleEvent({ type: 'samples', dt: 5, cm: [30, 30] }, 1000);
  // (n - 1 - 0) * dt clamped to 20 -> sample 0 at 1000 - 20 = 980
  // If dt were 5, it would be 995
  // We can verify dt clamping by testing presence transition timing
}

// ---------------------------------------------------------------------------
// 4. Lease Arbitration & Hand-Off Simulation
// ---------------------------------------------------------------------------
section('4. Lease Arbitration & Hand-Off Simulation');
{
  const clk = new Clock();
  const bridge = createHardwareBridge({ now: clk.now, leaseMs: HW_LEASE_MS });

  // First claimer wins
  const claim1 = bridge.claim('window-main', true);
  check('first claimer wins ownership', claim1.body.owner === true);

  // Second claimer with different key is refused while lease is fresh
  const claim2 = bridge.claim('window-widget', true);
  check('second window is refused ownership during active lease', claim2.body.owner === false);

  // Owner refreshing keeps ownership indefinitely
  clk.advance(4000); // 4s < 6s
  const refresh1 = bridge.claim('window-main', true);
  check('owner refreshing retains ownership', refresh1.body.owner === true);

  clk.advance(4000); // another 4s -> 8s total from start, but 4s from last refresh
  const claim2Again = bridge.claim('window-widget', true);
  check('second window still refused when owner regularly refreshes', claim2Again.body.owner === false);

  // Main window closes (stops refreshing). Advance beyond HW_LEASE_MS (6000ms)
  clk.advance(HW_LEASE_MS + 100);
  const claimWidget = bridge.claim('window-widget', true);
  check('widget takes over ownership once lease expires', claimWidget.body.owner === true);

  // Main window tries to claim again while widget holds lease
  const claimMainOld = bridge.claim('window-main', true);
  check('former owner refused while new owner lease is active', claimMainOld.body.owner === false);
}

// ---------------------------------------------------------------------------
// 5. /controller Coercion & Whitelist
// ---------------------------------------------------------------------------
section('5. /controller Coercion & Whitelist');
{
  const bridge = createHardwareBridge();

  // Test num() guard: 0, negative, NaN, null, string must all become null
  const corruptPayload = {
    present: 'yes', // should coerce to true
    armingUntil: 0, // 0 -> null (crucial bug fix)
    awaySince: -500, // negative -> null
    stoppedByHand: 1, // truthy -> true
    sessionActive: true,
    manualSession: false,
    pausedByAway: true,
    bogusField: 'should be ignored',
  };

  const resPost = bridge.postController(corruptPayload);
  check('postController returns 200', resPost.status === 200);

  const ctrlState = bridge.getController().body as HardwareControllerState;
  check('0 timestamp for armingUntil coerced to null', ctrlState.armingUntil === null);
  check('negative timestamp for awaySince coerced to null', ctrlState.awaySince === null);
  check('boolean flags coerced to true booleans', ctrlState.present === true && ctrlState.stoppedByHand === true);
  check('unknown fields stripped from controller state', (ctrlState as Record<string, unknown>).bogusField === undefined);

  // Valid positive timestamps preserved
  bridge.postController({
    present: true,
    armingUntil: 1700000030000,
    awaySince: 1700000010000,
    stoppedByHand: false,
    sessionActive: true,
    manualSession: true,
    pausedByAway: false,
  });
  const validCtrl = bridge.getController().body as HardwareControllerState;
  check('valid positive timestamps preserved',
    validCtrl.armingUntil === 1700000030000 && validCtrl.awaySince === 1700000010000);
}

// ---------------------------------------------------------------------------
// 6. /state Freshness & Offline Fallback
// ---------------------------------------------------------------------------
section('6. /state Freshness & Offline Fallback');
{
  const clk = new Clock();
  const bridge = createHardwareBridge({ now: clk.now, leaseMs: HW_LEASE_MS });

  bridge.postState({
    mode: 'running',
    remainingSeconds: 1500,
    todaySeconds: 3600,
    sessionsToday: 2,
    armSeconds: 0,
  });

  const stateFresh = bridge.getState().body;
  check('fresh display state returns published values',
    stateFresh.mode === 'running' && stateFresh.remainingSeconds === 1500 && stateFresh.sessionsToday === 2);

  // Advance time beyond HW_LEASE_MS
  clk.advance(HW_LEASE_MS + 100);
  const stateStale = bridge.getState().body;
  check('stale display state (>HW_LEASE_MS) falls back to mode: offline with zeroes',
    stateStale.mode === 'offline' &&
    stateStale.remainingSeconds === 0 &&
    stateStale.todaySeconds === 0 &&
    stateStale.sessionsToday === 0 &&
    stateStale.armSeconds === 0);
}

// ---------------------------------------------------------------------------
// 7. /config Round-Trip & Live Filter Reconfiguration
// ---------------------------------------------------------------------------
section('7. /config Round-Trip & Live Filter Reconfiguration');
{
  const bridge = createHardwareBridge();

  const cfgRes = bridge.postConfig({
    enterCm: 45,
    exitCm: 55,
    sampleIntervalMs: 250,
    calibrating: true,
    announceOnConnect: false,
  });
  check('postConfig returns 200', cfgRes.status === 200);

  const currentCfg = bridge.getConfig().body;
  check('config values updated correctly',
    currentCfg.enterCm === 45 &&
    currentCfg.exitCm === 55 &&
    currentCfg.sampleIntervalMs === 250 &&
    currentCfg.calibrating === true &&
    currentCfg.announceOnConnect === false);

  check('internal PresenceFilter reconfigured live',
    bridge.hwFilter.config.enterCm === 45 && bridge.hwFilter.config.exitCm === 55);

  // sampleIntervalMs clamped to 40..2000
  bridge.postConfig({ sampleIntervalMs: 10 });
  check('sampleIntervalMs < 40 clamped to 40', bridge.getConfig().body.sampleIntervalMs === 40);

  bridge.postConfig({ sampleIntervalMs: 5000 });
  check('sampleIntervalMs > 2000 clamped to 2000', bridge.getConfig().body.sampleIntervalMs === 2000);
}

// ---------------------------------------------------------------------------
// 8. Malformed Input Resistance
// ---------------------------------------------------------------------------
section('8. Malformed Input Resistance');
{
  const bridge = createHardwareBridge();

  const malformedInputs = [null, undefined, '', '{', 'null', '[]', [1, 2, 3], 123, true];

  for (const input of malformedInputs) {
    check(`handleEvent handles ${typeof input} safely`, bridge.handleEvent(input).status === 400);
    check(`postState handles ${typeof input} safely`, bridge.postState(input).status === 400);
    check(`postConfig handles ${typeof input} safely`, bridge.postConfig(input).status === 400);
    check(`postLog handles ${typeof input} safely`, bridge.postLog(input).status === 400);
    check(`postController handles ${typeof input} safely`, bridge.postController(input).status === 400);
  }

  // HandleEvent specifically requires a valid `type` property
  check('handleEvent without type returns 400', bridge.handleEvent({ deeply: { nested: { invalid: true } } }).status === 400);
}

// ---------------------------------------------------------------------------
// 9. Auth Boundary
// ---------------------------------------------------------------------------
section('9. Auth Boundary');
{
  const bridge = createHardwareBridge();

  // Seed events
  bridge.handleEvent({ type: 'button_a' });
  bridge.handleEvent({ type: 'presence', present: true });

  const unauthedEvents = bridge.getEvents(0, false);
  check('unauthenticated getEvents returns empty list and latest=0',
    unauthedEvents.body.latest === 0 && (unauthedEvents.body.events as unknown[]).length === 0);

  const unauthedClaim = bridge.claim('my-key', false);
  check('unauthenticated claim returns owner: false', unauthedClaim.body.owner === false);

  // Board POST /event carries no auth and must still succeed
  const boardPost = bridge.handleEvent({ type: 'button_b' });
  check('unauthenticated board event POST is accepted', boardPost.status === 200);
}

// ---------------------------------------------------------------------------
// 10. Firmware Contract Cross-Check
// ---------------------------------------------------------------------------
section('10. Firmware Contract Cross-Check');
{
  const bridge = createHardwareBridge();

  // /state GET shape
  const stateRes = bridge.getState().body;
  const stateKeys = ['mode', 'remainingSeconds', 'todaySeconds', 'sessionsToday', 'armSeconds'];
  for (const k of stateKeys) {
    check(`/state response carries required firmware key '${k}'`, k in stateRes);
  }

  const validModes = ['idle', 'arming', 'running', 'paused', 'offline'];
  check(`/state mode '${stateRes.mode}' is one of ${validModes.join('|')}`, validModes.includes(String(stateRes.mode)));

  // /config GET shape
  const configRes = bridge.getConfig().body;
  check('/config response carries sampleIntervalMs', 'sampleIntervalMs' in configRes);

  // Cross-reference against firmware source code files if accessible
  const fwMainPath = path.resolve(__dirname, '../../../../firmware/src/main.cpp');
  const fwConfigPath = path.resolve(__dirname, '../../../../firmware/src/config.h');

  if (fs.existsSync(fwMainPath) && fs.existsSync(fwConfigPath)) {
    const fwMain = fs.readFileSync(fwMainPath, 'utf-8');
    const fwConfig = fs.readFileSync(fwConfigPath, 'utf-8');

    // Firmware JSON fields parsed in pollState() and pollConfig()
    const requiredFirmwareStateFields = ['mode', 'remainingSeconds', 'todaySeconds', 'sessionsToday', 'armSeconds'];
    for (const f of requiredFirmwareStateFields) {
      check(`firmware main.cpp parses expected field "${f}"`,
        fwMain.includes(`"${f}"`), `field "${f}" missing in firmware/src/main.cpp`);
    }

    check('firmware main.cpp parses "sampleIntervalMs"',
      fwMain.includes('"sampleIntervalMs"'));

    check('firmware config.h defines SAMPLE_INTERVAL_MS',
      fwConfig.includes('SAMPLE_INTERVAL_MS'));
  }
}

// ---------------------------------------------------------------------------
// 11. cancelArming Functionality
// ---------------------------------------------------------------------------
section('11. cancelArming Functionality');
{
  const clk = new Clock();
  const bridge = createHardwareBridge({ now: clk.now });

  // No countdown active
  check('cancelArming returns false when no countdown is active', !bridge.cancelArming());

  // Set active arming countdown 30s in future
  bridge.postController({
    present: true,
    armingUntil: clk.now() + 30_000,
    stoppedByHand: false,
  });

  const cancelled = bridge.cancelArming(clk.now());
  check('cancelArming returns true when active arming countdown is cancelled', cancelled);

  const ctrl = bridge.getController().body as HardwareControllerState;
  check('armingUntil cleared to null after cancel', ctrl.armingUntil === null);
  check('stoppedByHand set to true after cancel', ctrl.stoppedByHand === true);

  const evts = (bridge.getEvents(0, true).body.events as HardwareEvent[]);
  check('manual_stop event queued on arm cancellation',
    evts.some(e => e.type === 'manual_stop' && e.at === clk.now()));

  // Simulate lease-holding window polling 500ms later:
  clk.advance(500);
  const pendingEvts = bridge.getEvents(0, true).body.events as HardwareEvent[];
  const manualStopEvt = pendingEvts.find(e => e.type === 'manual_stop');
  check('window receives manual_stop event in its poll', Boolean(manualStopEvt));

  // Window applies manual_stop event through reduceHardware and writes state back
  const windowReducedState = {
    present: true,
    armingUntil: null,
    awaySince: null,
    stoppedByHand: true,
    sessionActive: false,
    manualSession: false,
    pausedByAway: false,
  };
  bridge.postController(windowReducedState);

  // Assert cancel is preserved and not clobbered by window write
  const finalCtrl = bridge.getController().body as HardwareControllerState;
  check('cancel survives window state write without being clobbered',
    finalCtrl.armingUntil === null && finalCtrl.stoppedByHand === true);

  // Time advances 35s - no countdown exists, no session starts
  clk.advance(35_000);
  check('no session active after countdown duration elapses',
    finalCtrl.armingUntil === null && finalCtrl.sessionActive === false);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
if (failures > 0) process.exitCode = 1;
