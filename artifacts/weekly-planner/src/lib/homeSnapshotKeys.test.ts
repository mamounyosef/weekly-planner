import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from './settingsSync';
import { DEVICE_SCOPED_KEYS } from './deviceSettings';

// Run with: npx tsx src/lib/homeSnapshotKeys.test.ts

console.log('--- TESTING home.tsx currentSettingsSnapshot KEYS ---');

// The bug we just fixed was caused by home.tsx manually constructing the 
// settings snapshot (to avoid sending scoped settings of its own) but forgetting 
// to include 'notifications' and 'shortcutDefaultsVersion'. When saved, these 
// were dropped from the JSON and reverted to defaults.

// We will scan home.tsx for the currentSettingsSnapshot block and ensure every 
// key that belongs to the shared backend exists in that block.

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const homePath = path.join(__dirname, '../pages/home.tsx');
const homeSrc = fs.readFileSync(homePath, 'utf8');

// Find the currentSettingsSnapshot definition block
const snapshotMatch = homeSrc.match(/const currentSettingsSnapshot = useCallback\(\(\): AppSettings => \{[\s\S]*?return coerceSettings\(\{([\s\S]*?)\}\);/);
assert.ok(snapshotMatch, 'Could not find currentSettingsSnapshot block in home.tsx');

const snapshotBody = snapshotMatch[1];
const allAppKeys = Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>;

const missing: string[] = [];

for (const key of allAppKeys) {
  // Device-scoped keys are brought in via `...sharedScopedRef.current`
  if ((DEVICE_SCOPED_KEYS as readonly string[]).includes(key)) continue;
  
  // Not device scoped, must be explicitly included in the object literal
  // E.g. `notifications: notificationSettings,` or `notifications,`
  // We look for a word boundary around the key name to be sure.
  const regex = new RegExp(`\\b${key}\\b\\s*[:,]`);
  if (!regex.test(snapshotBody)) {
    missing.push(key);
  }
}

assert.deepEqual(missing, [], `The following global AppSettings keys are missing from home.tsx's currentSettingsSnapshot:\n${missing.join(', ')}`);

console.log('✓ All global AppSettings keys are correctly included in home.tsx currentSettingsSnapshot!');
