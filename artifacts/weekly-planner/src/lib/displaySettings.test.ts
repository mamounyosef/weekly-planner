// Tests the shared display settings: the ones that describe the planner rather
// than the screen, which the phone could read but never change.
//
// THE ONE THAT MATTERS: `displayPatch` must return ONLY what actually changed.
// The sync layer stamps every field it is handed, so a patch that carried all
// six would out-rank five settings the desk may have changed a second earlier
// for the sake of the one that moved. That is not an error anyone sees: it is a
// setting quietly reverting on the other machine.
//
// THE OTHER ONE: every reader is total and every writer idempotent. A value can
// arrive from an older build or a half finished merge, and a settings screen
// that throws is a settings screen you cannot use to fix the setting.
//
// Run with: npx tsx src/lib/displaySettings.test.ts

import assert from 'node:assert/strict';
import {
  CHECKBOX_SHAPES,
  DEFAULT_DISPLAY_SETTINGS,
  TASK_COLOURS,
  TIME_FORMATS,
  WEEK_START_LABELS,
  coerceDisplaySettings,
  describeDisplaySettings,
  describeFocusDay,
  describeHour,
  displayPatch,
  isCheckboxShape,
  isFocusDayStartHour,
  isHexColour,
  isTimeFormat,
  isWeekStart,
  isFocusGoalSeconds,
  describeFocusGoal,
  FOCUS_GOAL_CHOICES,
  type DisplaySettings,
} from './displaySettings';
import { SHARED_SETTING_KEYS } from './settingsScope';

/** Everything a value can be when it should not have been anything. */
const RUBBISH: unknown[] = [
  null, undefined, 0, 1, -1, NaN, Infinity, -Infinity, 0.5, '', ' ', 'x',
  '12h ', '12H', true, false, [], [1], {}, { a: 1 }, () => {}, new Date(),
  '#fff', '#1234567', 'red', '#GGGGGG', 7, -0.0001, 24, 12, 11.5,
];

function main() {
  console.log('--- 1. EVERY ONE OF THESE IS ACTUALLY A SHARED SETTING ---');
  {
    // The whole premise. If one of these were device scoped, the phone writing
    // it would be silently dropped at the door by `validateOp`, and the setting
    // would appear to save and then not.
    const shared = new Set<string>(SHARED_SETTING_KEYS as readonly string[]);
    for (const key of Object.keys(DEFAULT_DISPLAY_SETTINGS)) {
      assert.ok(shared.has(key), `${key} must be in SHARED_SETTING_KEYS`);
    }
  }

  console.log('--- 2. THE GUARDS ARE EXACTLY AS STRICT AS THEY CLAIM ---');
  {
    for (const good of ['12h', '24h']) assert.ok(isTimeFormat(good));
    for (const bad of RUBBISH.filter(v => v !== '12h' && v !== '24h')) {
      assert.ok(!isTimeFormat(bad), `${String(bad)} is not a clock`);
    }

    for (let d = 0; d <= 6; d += 1) assert.ok(isWeekStart(d), `${d} is a weekday`);
    for (const bad of [-1, 7, 0.5, 6.5, NaN, Infinity, '1', null, undefined, [], {}]) {
      assert.ok(!isWeekStart(bad), `${String(bad)} is not a weekday`);
    }

    for (const good of ['circle', 'square']) assert.ok(isCheckboxShape(good));
    for (const bad of ['Circle', 'round', '', null, 0]) {
      assert.ok(!isCheckboxShape(bad), `${String(bad)} is not a shape`);
    }

    for (const good of ['#000000', '#ffffff', '#64748B', ...TASK_COLOURS]) {
      assert.ok(isHexColour(good), `${good} is a colour`);
    }
    for (const bad of ['#fff', '#1234567', 'ffffff', '#12345g', ' #ffffff', null, 3]) {
      assert.ok(!isHexColour(bad), `${String(bad)} is not a colour`);
    }

    // A GOAL LONGER THAN A DAY IS NOT A GOAL, it is a bar that is always empty.
    for (const good of [0, 1, 1800, 3600, 24 * 3600, ...FOCUS_GOAL_CHOICES]) {
      assert.ok(isFocusGoalSeconds(good), `${good} is a goal`);
    }
    for (const bad of [-1, 24 * 3600 + 1, 1e9, 0.5, NaN, Infinity, '3600', null, {}]) {
      assert.ok(!isFocusGoalSeconds(bad), `${String(bad)} is not a goal`);
    }
    assert.equal(FOCUS_GOAL_CHOICES[0], 0, 'the first choice is no goal at all');
    assert.equal(new Set(FOCUS_GOAL_CHOICES).size, FOCUS_GOAL_CHOICES.length, 'no duplicates');

    // A FOCUS DAY MAY NOT ROLL OVER IN THE AFTERNOON. Past midday it stops
    // meaning "the small hours of yesterday" and starts cutting ordinary days
    // in half.
    for (let h = 0; h <= 11; h += 1) assert.ok(isFocusDayStartHour(h), `${h} is allowed`);
    for (const bad of [12, 13, 23, 24, -1, 4.5, NaN, Infinity, '4', null]) {
      assert.ok(!isFocusDayStartHour(bad), `${String(bad)} is not allowed`);
    }
  }

  console.log('--- 3. READING IS TOTAL, WHATEVER IS IN THE FILE ---');
  {
    for (const raw of [...RUBBISH, { weekStartsOn: 'monday' }, { timeFormat: 12 }]) {
      const got = coerceDisplaySettings(raw);
      assert.ok(isWeekStart(got.weekStartsOn), `${String(raw)} gives a weekday`);
      assert.ok(isTimeFormat(got.timeFormat), `${String(raw)} gives a clock`);
      assert.ok(isHexColour(got.taskColor), `${String(raw)} gives a colour`);
      assert.ok(isCheckboxShape(got.taskCheckboxShape), `${String(raw)} gives a shape`);
      assert.equal(typeof got.autoRollRecurringTasks, 'boolean');
      assert.ok(isFocusDayStartHour(got.focusDayStartHour));
      assert.ok(isFocusGoalSeconds(got.focusDailyGoalSeconds), `${String(raw)} gives a goal`);
    }

    // The defaults are themselves legal, which is not automatic.
    assert.deepEqual(coerceDisplaySettings(DEFAULT_DISPLAY_SETTINGS), DEFAULT_DISPLAY_SETTINGS);

    // ONE BAD FIELD NEVER COSTS THE OTHERS. Rejecting the whole object to
    // punish one value throws away five good settings.
    const mixed = coerceDisplaySettings({
      weekStartsOn: 0,
      timeFormat: 'nonsense',
      taskColor: '#ff0000',
      taskCheckboxShape: 'triangle',
      autoRollRecurringTasks: false,
      focusDayStartHour: 99,
    });
    assert.equal(mixed.weekStartsOn, 0, 'the good weekday survived');
    assert.equal(mixed.taskColor, '#ff0000', 'the good colour survived');
    assert.equal(mixed.autoRollRecurringTasks, false, 'the good boolean survived');
    assert.equal(mixed.timeFormat, DEFAULT_DISPLAY_SETTINGS.timeFormat, 'the bad clock fell back');
    assert.equal(mixed.taskCheckboxShape, DEFAULT_DISPLAY_SETTINGS.taskCheckboxShape);
    assert.equal(mixed.focusDayStartHour, DEFAULT_DISPLAY_SETTINGS.focusDayStartHour);

    // Colour case is folded, so one colour is one value.
    assert.equal(coerceDisplaySettings({ taskColor: '#AABBCC' }).taskColor, '#aabbcc');

    // Idempotent, which is what stops two machines writing at each other.
    for (const raw of [...RUBBISH, { weekStartsOn: 3 }, { taskColor: '#AABBCC' }]) {
      const once = coerceDisplaySettings(raw);
      assert.deepEqual(coerceDisplaySettings(once), once, 'stable under a second pass');
    }

    // A partial object keeps its own values and defaults the rest.
    assert.equal(coerceDisplaySettings({ weekStartsOn: 5 }).weekStartsOn, 5);
    assert.equal(coerceDisplaySettings({ weekStartsOn: 5 }).timeFormat,
      DEFAULT_DISPLAY_SETTINGS.timeFormat);
  }

  console.log('--- 4. A PATCH CARRIES ONLY WHAT MOVED ---');
  {
    const base: DisplaySettings = { ...DEFAULT_DISPLAY_SETTINGS };

    // The whole point: one change is one field.
    assert.deepEqual(displayPatch(base, { timeFormat: '24h' }), { timeFormat: '24h' });
    assert.deepEqual(displayPatch(base, { weekStartsOn: 0 }), { weekStartsOn: 0 });

    // Setting something to what it already is writes NOTHING. A redundant write
    // is a sync op that can lose a race against a real one.
    assert.deepEqual(displayPatch(base, { timeFormat: base.timeFormat }), {});

    // A LIST SETTING IS COMPARED BY VALUE. This one is not a nicety: the
    // coercion rebuilds every list it returns, so a reference comparison called
    // two identical exclusion lists a change and put `focusExcludedDates: []`
    // into every patch the phone sent. Changing the time format then broadcast
    // an empty list of excused days over the top of the real one on the PC.
    assert.deepEqual(displayPatch(base, { timeFormat: '24h' }), { timeFormat: '24h' },
      'the ONLY field in the patch is the one that moved');
    for (const key of Object.keys(DEFAULT_DISPLAY_SETTINGS) as (keyof DisplaySettings)[]) {
      const patch = displayPatch(base, { weekStartsOn: base.weekStartsOn === 0 ? 1 : 0 });
      if (key !== 'weekStartsOn') {
        assert.equal(key in patch, false, `${key} is not dragged along by an unrelated change`);
      }
    }

    const withDays: DisplaySettings = { ...base, focusExcludedDates: ['2026-08-24', '2026-08-25'] };
    assert.deepEqual(displayPatch(withDays, { focusExcludedDates: ['2026-08-24', '2026-08-25'] }), {},
      'the same days, listed again, are not a change');
    assert.deepEqual(displayPatch(withDays, { timeFormat: '24h' }), { timeFormat: '24h' },
      'and an unrelated change leaves the days alone');

    // A real change to the list IS written, in full: it is a whole-value field.
    assert.deepEqual(displayPatch(withDays, { focusExcludedDates: ['2026-08-24'] }),
      { focusExcludedDates: ['2026-08-24'] }, 'a day removed');
    assert.deepEqual(
      displayPatch(withDays, { focusExcludedDates: ['2026-08-24', '2026-08-25', '2026-08-26'] }),
      { focusExcludedDates: ['2026-08-24', '2026-08-25', '2026-08-26'] }, 'a day added');
    assert.deepEqual(displayPatch(withDays, { focusExcludedDates: [] }),
      { focusExcludedDates: [] }, 'clearing them is a real change and must survive');

    // ORDER IS PART OF THE VALUE, because nothing sorts this list on the way
    // through and two orders are two different stored values.
    assert.deepEqual(displayPatch(withDays, { focusExcludedDates: ['2026-08-25', '2026-08-24'] }),
      { focusExcludedDates: ['2026-08-25', '2026-08-24'] });

    // Rubbish inside the list is dropped by the coercion, and if what survives
    // matches what is already stored, that is not a change either.
    assert.deepEqual(
      displayPatch(withDays, { focusExcludedDates: ['2026-08-24', 7, null, '2026-08-25'] as never }),
      {}, 'the junk was never a value, so nothing moved');
    assert.deepEqual(displayPatch(base, {}), {});
    assert.deepEqual(displayPatch(base, base), {});

    // An invalid value is not written at all, rather than written as a default,
    // which would silently reset a setting the desk had deliberately changed.
    assert.deepEqual(displayPatch(base, { timeFormat: 'nope' as never }), {});
    assert.deepEqual(displayPatch(base, { focusDayStartHour: 20 }), {});
    assert.deepEqual(displayPatch(base, { taskColor: 'red' as never }), {});

    // Two changes at once carry both, and nothing else.
    assert.deepEqual(
      displayPatch(base, { timeFormat: '24h', weekStartsOn: 6 }),
      { timeFormat: '24h', weekStartsOn: 6 });

    // Patching a corrupt current value writes the field, because it genuinely
    // differs from what is stored.
    const fixed = displayPatch({ timeFormat: 'rubbish' }, { weekStartsOn: 0 });
    assert.deepEqual(fixed, { weekStartsOn: 0 }, 'only the asked for field');

    // Applying a patch and reading back gives what was asked for, for every
    // legal value of every field.
    for (const w of WEEK_START_LABELS.map(x => x.id)) {
      const applied = coerceDisplaySettings({ ...base, ...displayPatch(base, { weekStartsOn: w }) });
      assert.equal(applied.weekStartsOn, w, `week start ${w} round trips`);
    }
    for (const f of TIME_FORMATS.map(x => x.id)) {
      const applied = coerceDisplaySettings({ ...base, ...displayPatch(base, { timeFormat: f }) });
      assert.equal(applied.timeFormat, f, `clock ${f} round trips`);
    }
    for (const shape of CHECKBOX_SHAPES.map(x => x.id)) {
      const applied = coerceDisplaySettings({
        ...base, ...displayPatch(base, { taskCheckboxShape: shape }),
      });
      assert.equal(applied.taskCheckboxShape, shape, `${shape} round trips`);
    }
    for (const colour of TASK_COLOURS) {
      const applied = coerceDisplaySettings({ ...base, ...displayPatch(base, { taskColor: colour }) });
      assert.equal(applied.taskColor, colour.toLowerCase(), `${colour} round trips`);
    }
    for (let h = 0; h <= 11; h += 1) {
      const applied = coerceDisplaySettings({
        ...base, ...displayPatch(base, { focusDayStartHour: h }),
      });
      assert.equal(applied.focusDayStartHour, h, `focus hour ${h} round trips`);
    }
    for (const goal of FOCUS_GOAL_CHOICES) {
      const applied = coerceDisplaySettings({
        ...base, ...displayPatch(base, { focusDailyGoalSeconds: goal }),
      });
      assert.equal(applied.focusDailyGoalSeconds, goal, `goal ${goal} round trips`);
    }
    // An impossible goal is not written at all, rather than written as a default.
    assert.deepEqual(displayPatch(base, { focusDailyGoalSeconds: 99 * 3600 }), {});
    assert.deepEqual(displayPatch(base, { focusDailyGoalSeconds: -1 }), {});

    // A patch is idempotent: applying it twice changes nothing the second time.
    const after = coerceDisplaySettings({ ...base, ...displayPatch(base, { timeFormat: '24h' }) });
    assert.deepEqual(displayPatch(after, { timeFormat: '24h' }), {}, 'nothing left to write');
  }

  console.log('--- 5. THE OPTION LISTS ARE COMPLETE AND UNAMBIGUOUS ---');
  {
    assert.equal(WEEK_START_LABELS.length, 7, 'every day of the week');
    assert.deepEqual(WEEK_START_LABELS.map(w => w.id), [0, 1, 2, 3, 4, 5, 6], 'in order');
    for (const list of [
      WEEK_START_LABELS.map(x => x.id as unknown),
      TIME_FORMATS.map(x => x.id as unknown),
      CHECKBOX_SHAPES.map(x => x.id as unknown),
      [...TASK_COLOURS] as unknown[],
    ]) {
      assert.equal(new Set(list).size, list.length, 'no duplicates');
    }
    for (const colour of TASK_COLOURS) assert.ok(isHexColour(colour), `${colour} is real`);
    // The default is one of the offered colours, or it cannot be shown as chosen.
    assert.ok(TASK_COLOURS.includes(DEFAULT_DISPLAY_SETTINGS.taskColor),
      'the default colour is on the palette');
  }

  console.log('--- 6. WHAT A PERSON READS ---');
  {
    assert.equal(describeHour(0), 'midnight');
    assert.equal(describeHour(12), 'noon');
    assert.equal(describeHour(4), '4am');
    assert.equal(describeHour(13), '1pm');
    assert.equal(describeHour(4, '24h'), '04:00');
    assert.equal(describeHour(0, '24h'), '00:00');
    // Nonsense hours wrap rather than printing NaN at someone.
    for (const bad of [NaN, Infinity, -Infinity, 25, -3, 4.7]) {
      const out = describeHour(bad as number);
      assert.ok(out.length > 0 && !out.includes('NaN'), `${bad} reads as "${out}"`);
    }

    assert.ok(describeFocusDay(0).includes('midnight to midnight'));
    assert.ok(describeFocusDay(4).includes('4am'));
    // An impossible hour still produces the sentence for a sane one.
    assert.equal(describeFocusDay(99), describeFocusDay(DEFAULT_DISPLAY_SETTINGS.focusDayStartHour));

    // "No goal" is a sentence, not an empty string.
    assert.equal(describeFocusGoal(0), 'No goal');
    assert.equal(describeFocusGoal(3600), '1 hour a day');
    assert.equal(describeFocusGoal(7200), '2 hours a day');
    assert.equal(describeFocusGoal(1800), '30 minutes a day');
    assert.equal(describeFocusGoal(5400), '1h 30m a day');
    for (const bad of [-1, NaN, Infinity, 99 * 3600]) {
      assert.equal(describeFocusGoal(bad as number), 'No goal', `${bad} reads as no goal`);
    }
    for (const goal of FOCUS_GOAL_CHOICES) {
      const line = describeFocusGoal(goal);
      assert.ok(line.length > 0 && !line.includes('NaN'), `${goal} reads as "${line}"`);
      assert.ok(!line.includes('—') && !line.includes('–'), `no dash in "${line}"`);
    }

    assert.ok(describeDisplaySettings(DEFAULT_DISPLAY_SETTINGS).includes('Monday'));
    assert.ok(describeDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, weekStartsOn: 0 })
      .includes('Sunday'));

    // NO DASHES, in any sentence this module can produce.
    const lines: string[] = [];
    for (let h = 0; h <= 11; h += 1) {
      for (const clock of ['12h', '24h'] as const) {
        lines.push(describeFocusDay(h, clock), describeHour(h, clock));
      }
    }
    for (const w of WEEK_START_LABELS.map(x => x.id)) {
      for (const f of TIME_FORMATS.map(x => x.id)) {
        lines.push(describeDisplaySettings({ ...DEFAULT_DISPLAY_SETTINGS, weekStartsOn: w, timeFormat: f }));
      }
    }
    for (const l of [...lines, ...TIME_FORMATS.map(x => x.hint), ...WEEK_START_LABELS.map(x => x.label)]) {
      assert.ok(l.length > 0, 'there is something to read');
      assert.ok(!l.includes('—') && !l.includes('–'), `no dash in "${l}"`);
    }
  }

  console.log('\nALL PASS (displaySettings: shared scope, total reads, minimal patches, wording)');
}

main();
