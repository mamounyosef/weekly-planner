// Builds the Android icon set from the planner's own icon.
//
// Android's adaptive icon crops the foreground to a mask (circle, squircle,
// rounded square — the launcher chooses). Only the middle ~66% is guaranteed to
// survive, so dropping a full-bleed square icon straight in gets the artwork
// zoomed and its edges cut off. This scales the source into that safe zone on a
// transparent canvas and paints the background separately, so the clock stays
// whole whatever mask the phone applies.
//
// Run with: node scripts/make-icons.mjs

import Jimp from 'jimp-compact';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const SOURCE = path.resolve(root, '..', 'app-icon.png');
const ASSETS = path.join(root, 'assets');

/** Fraction of the canvas the artwork may occupy. Android's own guidance. */
const SAFE_FRACTION = 0.66;
const CANVAS = 1024;

async function main() {
  const source = await Jimp.read(SOURCE);

  // The icon's own background colour, sampled just inside a corner, so the
  // adaptive background matches the artwork instead of guessing a blue.
  const corner = Jimp.intToRGBA(source.getPixelColor(
    Math.round(source.bitmap.width * 0.5),
    Math.round(source.bitmap.height * 0.06),
  ));
  const bgHex = `#${[corner.r, corner.g, corner.b]
    .map(v => v.toString(16).padStart(2, '0')).join('')}`;

  // 1. The plain icon, used for the legacy launcher icon and the web favicon.
  await source.clone().resize(CANVAS, CANVAS).writeAsync(path.join(ASSETS, 'icon.png'));
  await source.clone().resize(512, 512).writeAsync(path.join(ASSETS, 'favicon.png'));

  // 2. Adaptive foreground: artwork inside the safe zone, transparent around it.
  const art = source.clone().resize(
    Math.round(CANVAS * SAFE_FRACTION),
    Math.round(CANVAS * SAFE_FRACTION),
  );
  const foreground = await new Jimp(CANVAS, CANVAS, 0x00000000);
  const offset = Math.round((CANVAS - art.bitmap.width) / 2);
  foreground.composite(art, offset, offset);
  await foreground.writeAsync(path.join(ASSETS, 'android-icon-foreground.png'));

  // 3. Adaptive background: a flat fill in the icon's own colour.
  const background = await new Jimp(CANVAS, CANVAS, bgHex);
  await background.writeAsync(path.join(ASSETS, 'android-icon-background.png'));

  // 4. Monochrome (themed icons on Android 13+): the artwork as a silhouette,
  //    because a themed icon is recoloured by the system and only shape matters.
  const mono = art.clone().greyscale().contrast(1);
  const monochrome = await new Jimp(CANVAS, CANVAS, 0x00000000);
  monochrome.composite(mono, offset, offset);
  await monochrome.writeAsync(path.join(ASSETS, 'android-icon-monochrome.png'));

  // 5. Splash: the icon at a comfortable size on transparency.
  const splash = await new Jimp(CANVAS, CANVAS, 0x00000000);
  const splashArt = source.clone().resize(Math.round(CANVAS * 0.5), Math.round(CANVAS * 0.5));
  const splashOffset = Math.round((CANVAS - splashArt.bitmap.width) / 2);
  splash.composite(splashArt, splashOffset, splashOffset);
  await splash.writeAsync(path.join(ASSETS, 'splash-icon.png'));

  console.log(`Icons written to assets/ (background sampled as ${bgHex})`);
  console.log('Set android.adaptiveIcon.backgroundColor to that value in app.json.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
