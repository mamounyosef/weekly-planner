// Tests for voice mode's text helpers (src/lib/voice/speechText.ts).
//
// What the voice says must be exactly the words the model wrote, each once,
// in order, with no markdown read out loud; and a spoken "no" must never be
// taken as permission to delete.
//
// Run with: npx tsx src/lib/voice/speechText.test.ts

import assert from 'node:assert/strict';

import { PAUSE_STEPS, SentenceSplitter, approvalSpeech, endpointMs, questionSpeech, speakable, yesOrNo } from './speechText';
import { coerceVoicePrefs } from './voiceTypes';

let passed = 0;
function t(name: string, fn: () => void) {
  try { fn(); passed++; } catch (e) { console.error(`FAIL: ${name}`); throw e; }
}

/** Stream `text` into a splitter in chunks of `n` characters, as tokens arrive. */
function stream(text: string, n: number): string[] {
  const sp = new SentenceSplitter();
  const out: string[] = [];
  for (let i = n; i < text.length + n; i += n) out.push(...sp.push(text.slice(0, Math.min(i, text.length))));
  out.push(...sp.finish(text));
  return out;
}

const words = (s: string) => speakable(s).replace(/[^\p{L}\p{N}' ]+/gu, ' ').split(/\s+/).filter(Boolean);

console.log('--- 1. SPEAKABLE: FORMATTING OUT, WORDS IN ---');
t('bold and italics', () => assert.equal(speakable('**Gym** at *6 PM*'), 'Gym at 6 PM'));
t('underscore emphasis', () => assert.equal(speakable('__Done__, _moved_ it.'), 'Done, moved it.'));
t('snake_case words keep their letters', () => assert.equal(speakable('my_task list'), 'my task list'));
t('headings', () => assert.equal(speakable('## Tomorrow\nTwo things.'), 'Tomorrow Two things.'));
t('bullets and numbers', () => assert.equal(speakable('- Gym\n* Lunch\n+ Study\n1. Call mum\n2) Pray'), 'Gym Lunch Study Call mum Pray'));
t('a bullet character', () => assert.equal(speakable('• Gym'), 'Gym'));
t('links keep their text', () => assert.equal(speakable('See [the agenda](https://x.com/a) now'), 'See the agenda now'));
t('bare urls', () => assert.equal(speakable('Join at https://meet.google.com/abc please'), 'Join at a link please'));
t('images', () => assert.equal(speakable('![screenshot](x.png) read'), 'screenshot read'));
t('inline code', () => assert.equal(speakable('id `abc`'), 'id abc'));
t('code blocks vanish', () => assert.equal(speakable('Before\n```\nconst x = 1;\n```\nAfter'), 'Before After'));
t('quotes', () => assert.equal(speakable('> Quoted line'), 'Quoted line'));
t('em and en dashes become pauses', () => assert.equal(speakable('Gym—then lunch – later'), 'Gym, then lunch, later'));
t('spaced hyphen becomes a pause', () => assert.equal(speakable('Gym - then lunch'), 'Gym, then lunch'));
t('hyphenated words stay', () => assert.equal(speakable('a follow-up check-in'), 'a follow-up check-in'));
t('ampersand', () => assert.equal(speakable('Rules & scoring'), 'Rules and scoring'));
t('emoji', () => assert.equal(speakable('Done 🎉 all set ✅'), 'Done all set'));
t('table rows', () => assert.equal(speakable('| Day | Item |\n|---|---|\n| Mon | Gym |'), 'Day, Item Mon, Gym'));
t('no space before punctuation', () => assert.equal(speakable('Done **.**'), 'Done.'));
t('empty and nullish', () => { assert.equal(speakable(''), ''); assert.equal(speakable(undefined as any), ''); assert.equal(speakable(null as any), ''); });
t('only symbols', () => assert.equal(speakable('***'), ''));
t('times and decimals untouched', () => assert.equal(speakable('At 10:30, 2.5 hours'), 'At 10:30, 2.5 hours'));
t('leading comma trimmed', () => assert.equal(speakable('- , gym'), 'gym'));

console.log('--- 2. SENTENCES: EACH WORD ONCE, IN ORDER ---');
const REPLY = 'Sure. I moved **Gym** to Thursday at 6 p.m. Then I added a reminder 30 minutes before. Dr. Lee is still at 9:30 a.m. on Friday! Anything else?';
for (const n of [1, 2, 3, 5, 7, 11, 40, 1000]) {
  t(`chunk size ${n}: no word lost or doubled`, () => {
    const got = stream(REPLY, n);
    assert.deepEqual(words(got.join(' ')), words(REPLY));
  });
}
t('splits at sentence ends', () => {
  const got = stream(REPLY, 1000);
  assert.deepEqual(got, [
    'Sure.',
    'I moved Gym to Thursday at 6 p.m.',
    'Then I added a reminder 30 minutes before.',
    'Dr. Lee is still at 9:30 a.m. on Friday!',
    'Anything else?',
  ]);
});
t('a sentence is not handed out before the next character proves it ended', () => {
  const sp = new SentenceSplitter();
  assert.deepEqual(sp.push('Done.'), []);
  assert.deepEqual(sp.push('Done. '), ['Done.']);
});
t('decimals and times do not split', () => {
  assert.deepEqual(stream('It takes 2.5 hours. Starts at 10:30 today.', 1), ['It takes 2.5 hours.', 'Starts at 10:30 today.']);
});
t('abbreviations do not split', () => {
  const text = 'Meet Dr. Smith and Mrs. Jones at St. Mary, e.g. tomorrow.';
  const got = stream(text, 1);
  // (The first piece may still go early at the comma; that is not a split at an abbreviation.)
  assert.ok(got.every(g => !/\b(Dr|Mrs|St|e\.g)\.$/.test(g)), JSON.stringify(got));
  assert.deepEqual(words(got.join(' ')), words(text));
  assert.deepEqual(stream('See Dr. Lee. Then Mrs. Jones.', 1), ['See Dr. Lee.', 'Then Mrs. Jones.']);
});
t('month abbreviations do not split', () => {
  assert.deepEqual(stream('On Oct. 23 you have two things.', 3), ['On Oct. 23 you have two things.']);
});
t('initials do not split', () => {
  assert.deepEqual(stream('Call J. Smith now.', 1), ['Call J. Smith now.']);
});
t('p.m. followed by lowercase stays one sentence', () => {
  assert.deepEqual(stream('At 6 p.m. tomorrow you have gym.', 2), ['At 6 p.m. tomorrow you have gym.']);
});
t('newlines split list items', () => {
  assert.deepEqual(stream('Tomorrow:\n- Gym at 6\n- Lunch at 1\nThat is all.', 1), ['Tomorrow:', 'Gym at 6', 'Lunch at 1', 'That is all.']);
});
t('closing quotes stay with their sentence', () => {
  assert.deepEqual(stream('I called it "Gym." Next one.', 1), ['I called it "Gym."', 'Next one.']);
});
t('closing bracket stays with its sentence', () => {
  assert.deepEqual(stream('Added (with a reminder.) Done.', 1), ['Added (with a reminder.)', 'Done.']);
});
t('question and exclamation marks', () => {
  assert.deepEqual(stream('Really? Yes! Ok.', 1), ['Really?', 'Yes!', 'Ok.']);
});
t('no final punctuation: finish says the rest', () => {
  assert.deepEqual(stream('Done, gym moved to Thursday', 4), ['Done, gym moved to Thursday']);
});
t('pure markdown pieces say nothing', () => {
  assert.deepEqual(stream('---\n**Done.**\n\n', 1), ['Done.']);
});
t('empty text', () => { assert.deepEqual(stream('', 1), []); assert.deepEqual(stream('   \n\n', 1), []); });
t('the first piece goes early at a comma when long', () => {
  const sp = new SentenceSplitter();
  const got = sp.push('Okay, so I looked through your whole Thursday and Friday, and there are a few free slots ');
  assert.equal(got.length, 1);
  assert.ok(got[0].endsWith(','), got[0]);
});
t('a very long sentence is cut at a comma', () => {
  const long = `${'word '.repeat(30)}, ${'more '.repeat(30)}, ${'end '.repeat(10)}.`;
  const got = stream(long, 3);
  assert.ok(got.length >= 2, String(got.length));
  assert.deepEqual(words(got.join(' ')), words(long));
});
t('a very long run with no punctuation is still cut', () => {
  const long = 'word '.repeat(120).trim();
  const got = stream(long, 5);
  assert.ok(got.length >= 2);
  assert.ok(got.every(g => g.length <= 330), String(got.map(g => g.length)));
  assert.deepEqual(words(got.join(' ')), words(long));
});
t('push is idempotent for the same text', () => {
  const sp = new SentenceSplitter();
  assert.deepEqual(sp.push('One. Two. '), ['One.', 'Two.']);
  assert.deepEqual(sp.push('One. Two. '), []);
  assert.deepEqual(sp.push('One. Two. '), []);
});
t('a shorter text starts over (a new step)', () => {
  const sp = new SentenceSplitter();
  assert.deepEqual(sp.push('First step text. '), ['First step text.']);
  assert.deepEqual(sp.push('New. '), ['New.']);
});
t('finish twice says nothing new', () => {
  const sp = new SentenceSplitter();
  assert.deepEqual(sp.finish('All done'), ['All done']);
  assert.deepEqual(sp.finish('All done'), []);
});
t('reset forgets', () => {
  const sp = new SentenceSplitter();
  sp.push('A b c. ');
  sp.reset();
  assert.deepEqual(sp.push('A b c. '), ['A b c.']);
});
t('position tracks what was handed out', () => {
  const sp = new SentenceSplitter();
  sp.push('One. Two');
  assert.equal(sp.position, 'One.'.length);
});
t('colon only breaks before a new line', () => {
  assert.deepEqual(stream('Note: gym moved. Done.', 1), ['Note: gym moved.', 'Done.']);
  assert.deepEqual(stream('Tomorrow:\nGym.', 1), ['Tomorrow:', 'Gym.']);
});
t('ellipsis does not create empty pieces', () => {
  const got = stream('Hmm... let me check. Okay.', 1);
  assert.ok(got.every(g => /\w/.test(g)));
  assert.deepEqual(words(got.join(' ')), words('Hmm... let me check. Okay.'));
});
t('emoji-only sentences are skipped', () => {
  assert.deepEqual(stream('Done. 🎉 Next.', 1), ['Done.', 'Next.']);
});

console.log('--- 3. YES OR NO (DELETES) ---');
const YES = ['yes', 'Yes.', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'Okay, go ahead', 'do it', 'delete them', 'delete it', 'remove those', 'confirm', 'confirmed', 'approve', 'correct', 'please do', 'absolutely', 'of course', 'definitely', 'sounds good', "that's right", 'go for it', 'proceed', 'get rid of them', 'yes, no problem', 'Sure, no worries', 'yeah no doubt'];
const NO = ['no', 'No.', 'nope', 'nah', "don't", 'do not', 'cancel', 'stop', 'wait', 'hold on', 'never mind', 'nevermind', 'keep it', 'keep them', 'not that one', 'not yet', 'deny', 'leave it', 'scratch that', 'no, keep them', 'yes, wait, no', "yeah don't delete the second", 'ok stop'];
for (const y of YES) t(`"${y}" is yes`, () => assert.equal(yesOrNo(y), 'yes'));
for (const n of NO) t(`"${n}" is no`, () => assert.equal(yesOrNo(n), 'no'));
for (const x of ['', '   ', 'what time is it', 'move it to Friday instead', 'the second one', undefined as any, null as any]) {
  t(`"${x}" is neither`, () => assert.equal(yesOrNo(x), null));
}
t('words containing no are not no', () => assert.equal(yesOrNo('I know, go ahead'), 'yes'));
t('"nothing" is not a no', () => assert.equal(yesOrNo('nothing else, yes'), 'yes'));
t('"knowledge" is not a no', () => assert.equal(yesOrNo('acknowledged'), null));

console.log('--- 4. SPOKEN APPROVAL AND QUESTIONS ---');
t('one item', () => assert.equal(
  approvalSpeech({ deletions: [{ id: 'a', kind: 'event', title: 'Gym', scopeLabel: 'Only this one', when: 'Thu 23 Oct, 6:00 PM' }] }),
  'Should I delete Gym, Thu 23 Oct, 6:00 PM? Say yes or no.'));
t('several items', () => {
  const s = approvalSpeech({ deletions: [
    { id: 'a', kind: 'event', title: 'Gym', scopeLabel: 'The whole series', when: 'Thursdays' },
    { id: 'b', kind: 'task', title: '**Call** mum', scopeLabel: '', when: '' },
  ] });
  assert.equal(s, 'Should I delete these 2: Gym, Thursdays, the whole series and Call mum? Say yes or no.');
});
t('more than four', () => {
  const d = Array.from({ length: 6 }, (_, i) => ({ id: String(i), kind: 'task' as const, title: `T${i}`, scopeLabel: '', when: '' }));
  assert.equal(approvalSpeech({ deletions: d }), 'Should I delete these 6: T0, T1, T2 and T3, and 2 more? Say yes or no.');
});
t('nothing listed', () => assert.equal(approvalSpeech({ deletions: [] }), 'Should I go ahead and delete that? Say yes or no.'));
t('missing deletions', () => assert.equal(approvalSpeech({} as any), 'Should I go ahead and delete that? Say yes or no.'));
t('question with options', () => assert.equal(
  questionSpeech([{ id: 'q', header: 'Day', question: 'Which day', multiSelect: false, allowOther: true, options: [{ label: 'Thursday 23 Oct (Recommended)' }, { label: 'Friday 24 Oct' }] }]),
  'Which day? Thursday 23 Oct, or Friday 24 Oct?'));
t('question with one option', () => assert.equal(
  questionSpeech([{ id: 'q', header: 'x', question: 'Is 6 PM right?', multiSelect: false, allowOther: true, options: [{ label: 'Yes.' }] }]),
  'Is 6 PM right? Yes?'));
t('question without options', () => assert.equal(
  questionSpeech([{ id: 'q', header: 'x', question: 'What time?', multiSelect: false, allowOther: true, options: [] }]),
  'What time?'));
t('several questions', () => assert.equal(
  questionSpeech([
    { id: 'a', header: 'x', question: 'Which day?', multiSelect: false, allowOther: true, options: [{ label: 'Mon' }, { label: 'Tue' }, { label: 'Wed' }] },
    { id: 'b', header: 'y', question: 'Reminder?', multiSelect: false, allowOther: true, options: [] },
  ]),
  'Which day? Mon, Tue, or Wed? Reminder?'));
t('no questions', () => { assert.equal(questionSpeech([]), ''); assert.equal(questionSpeech(undefined as any), ''); });

console.log('--- 5. PAUSE LENGTH ---');
t('pause lengths', () => {
  assert.equal(endpointMs('quick'), 500);
  assert.equal(endpointMs('balanced'), 750);
  assert.equal(endpointMs('patient'), 1150);
  assert.equal(endpointMs('relaxed'), 2000);
  assert.equal(endpointMs('slow'), 3500);
  assert.equal(endpointMs('unhurried'), 5500);
  assert.equal(endpointMs('endless'), 9000);
  assert.equal(endpointMs(undefined), 750);
  // Every step is strictly longer than the one before, and survives a save round trip.
  for (let i = 1; i < PAUSE_STEPS.length; i++) assert.ok(PAUSE_STEPS[i].ms > PAUSE_STEPS[i - 1].ms);
  // Old saves (a named pause) carry over to seconds; new saves are clamped to the slider.
  for (const s of PAUSE_STEPS) assert.equal(coerceVoicePrefs({ pause: s.id }).pauseMs, s.ms);
  assert.equal(coerceVoicePrefs({ pause: 'bogus' }).pauseMs, 750);
  assert.equal(coerceVoicePrefs({}).pauseMs, 750);
  assert.equal(coerceVoicePrefs({ pauseMs: 4300 }).pauseMs, 4300);
  assert.equal(coerceVoicePrefs({ pauseMs: 50 }).pauseMs, 400);
  assert.equal(coerceVoicePrefs({ pauseMs: 99999 }).pauseMs, 12000);
  assert.equal(coerceVoicePrefs({ pauseMs: 'x', pause: 'slow' }).pauseMs, 3500);
  assert.equal(coerceVoicePrefs({ pauseMs: 6000, pause: 'quick' }).pauseMs, 6000);
  assert.equal(coerceVoicePrefs({}).trailBoost, 1.9);
  assert.equal(coerceVoicePrefs({ trailBoost: 9 }).trailBoost, 3);
  assert.equal(coerceVoicePrefs({ trailBoost: 0 }).trailBoost, 1);
  assert.equal(coerceVoicePrefs({}).sensitivity, 50);
  assert.equal(coerceVoicePrefs({ sensitivity: 250 }).sensitivity, 100);
  assert.equal(coerceVoicePrefs({ sensitivity: -4 }).sensitivity, 0);
  assert.equal(coerceVoicePrefs({}).maxTurnS, 45);
  assert.equal(coerceVoicePrefs({ maxTurnS: 3 }).maxTurnS, 15);
  assert.equal(coerceVoicePrefs({ maxTurnS: 9999 }).maxTurnS, 180);
  assert.equal(coerceVoicePrefs({}).unfinishedBoost, 1.35);
  assert.equal(coerceVoicePrefs({ unfinishedBoost: 5 }).unfinishedBoost, 2);
  assert.equal(endpointMs('nonsense'), 750);
});

console.log(`\nAll ${passed} speechText tests passed.`);
