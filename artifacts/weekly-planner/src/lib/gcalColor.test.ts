// ─── Ink that can actually be read on the fill ───────────────────────────────
//
// The week, day and custom grids drew every block's title in hardcoded white on
// the raw category fill. On sand, sage, teal and peach that lands near 2:1,
// which is below every legibility floor there is. The month view had worked the
// right answer out for itself and kept it private, so the SAME event was
// readable in one view and not in another, which reads as a rendering fault
// rather than as a choice. One copy of the decision now, in the shared lib.

import assert from 'node:assert/strict';
import { inkOn, inkOpacityOn, SWATCH_BASE_HEX, FALLBACK_EVENT_HEX } from './gcalColor';

const WHITE = '#FFFFFF';
const NEAR_BLACK = '#15151E';

/** Rec. 709 relative luminance of a `#rrggbb`, 0 to 255. */
function lum(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` values. */
function contrast(a: string, b: string): number {
  const chan = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const rel = (hex: string) => {
    const h = hex.replace('#', '');
    return 0.2126 * chan(parseInt(h.slice(0, 2), 16))
      + 0.7152 * chan(parseInt(h.slice(2, 4), 16))
      + 0.0722 * chan(parseInt(h.slice(4, 6), 16));
  };
  const [hi, lo] = [rel(a), rel(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ─── 1. Every swatch the app can actually paint ─────────────────────────────
{
  console.log('--- INK ON EVERY SWATCH ---');

  const names = Object.keys(SWATCH_BASE_HEX);
  assert.ok(names.length >= 10, 'the palette is the ten the app offers');

  for (const name of names) {
    const fill = SWATCH_BASE_HEX[name];
    const ink = inkOn(fill);
    assert.ok(ink === WHITE || ink === NEAR_BLACK, `${name} gets one of the two inks`);

    // THE POINT OF THE WHOLE EXERCISE. Not "some colour was returned" but "the
    // colour returned can be read". 3:1 is the floor for large text, which is
    // what a block title is; the old fixed white failed this on four swatches.
    const ratio = contrast(ink, fill);
    assert.ok(ratio >= 3, `${name} (${fill}) reads at ${ratio.toFixed(2)}:1, which is legible`);

    // WHITE IS KEPT WHEREVER IT STILL READS. The defect was four swatches
    // below the floor, not "the contrast could be higher" -- flipping a fill
    // that was already legible would be a large uninvited change to how the
    // calendar looks, in exchange for nothing.
    if (contrast(WHITE, fill) >= 3) {
      assert.equal(ink, WHITE, `${name} was already legible in white, so it keeps it`);
    } else {
      assert.equal(ink, NEAR_BLACK, `${name} was illegible in white, so it switches`);
    }
  }

  // The four the report named, spelled out, so a regression names itself.
  assert.equal(inkOn(SWATCH_BASE_HEX.sand), NEAR_BLACK, 'sand is a light fill: dark ink');
  assert.equal(inkOn(SWATCH_BASE_HEX.sage), NEAR_BLACK, 'sage is a light fill: dark ink');
  assert.equal(inkOn(SWATCH_BASE_HEX.teal), NEAR_BLACK, 'teal is a light fill: dark ink');
  assert.ok(contrast(WHITE, SWATCH_BASE_HEX.sand) < 3,
    'and the old hardcoded white really was illegible on it');

  assert.equal(inkOn(SWATCH_BASE_HEX.peach), NEAR_BLACK, 'and so is peach');
  assert.equal(inkOn(SWATCH_BASE_HEX.emerald), NEAR_BLACK, 'and emerald');

  // Dark swatches keep white, so nothing that was already right has been
  // inverted. This is half the point: the fix must be invisible where there
  // was nothing wrong.
  assert.equal(inkOn(SWATCH_BASE_HEX.lavender), WHITE, 'a deep indigo keeps white');
  assert.equal(inkOn(SWATCH_BASE_HEX.blue), WHITE, 'so does blue');
  assert.equal(inkOn(SWATCH_BASE_HEX.coral), WHITE, 'and coral');
  assert.equal(inkOn(SWATCH_BASE_HEX.rose), WHITE, 'and rose');
  const flipped = Object.keys(SWATCH_BASE_HEX)
    .filter(n => inkOn(SWATCH_BASE_HEX[n]) === NEAR_BLACK).sort();
  assert.deepEqual(flipped, ['emerald', 'peach', 'sage', 'sand', 'teal'],
    'exactly the five that were unreadable change, and nothing else');
  assert.equal(inkOn(FALLBACK_EVENT_HEX), inkOn(SWATCH_BASE_HEX.sage), 'the fallback is sage');

  console.log('  Every swatch reads at 3:1 or better');
}

// ─── 2. The threshold, from both sides ──────────────────────────────────────
{
  console.log('\n--- THE THRESHOLD ---');

  assert.equal(inkOn('#000000'), WHITE, 'black takes white');
  assert.equal(inkOn('#ffffff'), NEAR_BLACK, 'white takes near-black');

  // A grey ramp must switch exactly once, and never switch back: a function
  // that flips twice would make two similar fills disagree for no reason.
  let switches = 0;
  let previous = inkOn('#000000');
  for (let v = 0; v <= 255; v += 1) {
    const hex = '#' + v.toString(16).padStart(2, '0').repeat(3);
    const ink = inkOn(hex);
    if (ink !== previous) { switches += 1; previous = ink; }
  }
  assert.equal(switches, 1, 'the ink changes exactly once across the whole grey ramp');

  // Either side of the documented cut, by luminance rather than by a magic hex.
  // Wherever it says white, white really is legible; wherever it says dark,
  // white really was not. Stated over the whole ramp rather than at one point.
  for (let v = 0; v <= 255; v += 3) {
    const hex = '#' + v.toString(16).padStart(2, '0').repeat(3);
    const ok = contrast(WHITE, hex) >= 3;
    assert.equal(inkOn(hex), ok ? WHITE : NEAR_BLACK, `${hex} follows the floor`);
    assert.ok(contrast(inkOn(hex), hex) >= 3, `${hex} ends up legible either way`);
  }
  assert.ok(lum('#ffffff') > 0, 'luminance helper is real');

  console.log('  One clean switch, in the right place');
}

// ─── 3. Anything that is not a colour ───────────────────────────────────────
{
  console.log('\n--- RUBBISH IN ---');

  // White is the safe answer, because most fills in this app are saturated and
  // a dark ink on an unknown fill is the worse of the two guesses.
  const rubbish: Array<string | undefined> = [
    undefined, '', '   ', 'red', 'rebeccapurple', '#', '#f', '#ff', '#ffff',
    '#fffff', '#fffffff', '#gggggg', '#ff00zz', 'rgb(1,2,3)', 'transparent',
    '#12345 ', 'null', 'undefined',
  ];
  for (const bad of rubbish) {
    assert.equal(inkOn(bad), WHITE, `${JSON.stringify(bad)} falls back to white`);
  }

  // Shorthand is understood, because a hand-typed category colour may be three
  // digits and silently going white on it would be the same bug again.
  assert.equal(inkOn('#fff'), NEAR_BLACK, 'three-digit white is still white');
  assert.equal(inkOn('#000'), WHITE, 'three-digit black is still black');
  assert.equal(inkOn('#eb3'), inkOn('#eebb33'), 'shorthand expands the way CSS does');

  // Case and surrounding space are not a different colour.
  assert.equal(inkOn('#EAB308'), inkOn('#eab308'), 'case does not change the answer');
  assert.equal(inkOn('  #eab308  '), inkOn('#eab308'), 'nor does whitespace');
  assert.equal(inkOn('eab308'), inkOn('#eab308'), 'nor a missing hash');

  console.log('  Nothing throws, and the fallback is the safe one');
}

// ─── 4. The second line on a block ──────────────────────────────────────────
{
  console.log('\n--- THE QUIETER LINE ---');

  // A block draws its time under its title. The time is meant to be quieter,
  // and on a coloured fill the way to do that is opacity, not a third hue.
  for (const name of Object.keys(SWATCH_BASE_HEX)) {
    const o = inkOpacityOn(SWATCH_BASE_HEX[name]);
    assert.ok(o > 0.5 && o < 1, `${name} stays legible while being quieter (${o})`);
  }
  assert.ok(inkOpacityOn('#000000') > inkOpacityOn('#ffffff'),
    'dark ink is faded less than white, because it starts with less headroom');
  assert.equal(inkOpacityOn(undefined), inkOpacityOn('#000000'),
    'an unknown fill follows its ink, which is white');

  console.log('  The second line is quieter without going unreadable');
}

console.log('\nALL PASS (gcalColor: readable ink on any fill)');
