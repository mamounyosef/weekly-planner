// Prints the SVG markup of lucide icons as JSON: { name: "<svg ...>" }.
// Used to add icons to the Android app, whose icons are pre-rendered PNGs
// (mobile/src/ui/icons.ts): the SVGs are rasterised to PNG afterwards.
//
// Run with: node scripts/lucide-svgs.mjs sparkles send paperclip ...

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as lucide from 'lucide-react';

const pascal = (kebab) => kebab.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('');

const out = {};
for (const name of process.argv.slice(2)) {
  const Icon = lucide[pascal(name)] ?? lucide[`${pascal(name)}Icon`];
  if (!Icon) { console.error(`unknown icon: ${name}`); process.exit(1); }
  out[name] = renderToStaticMarkup(createElement(Icon, { size: 24, color: '#ffffff', strokeWidth: 2 }));
}
console.log(JSON.stringify(out));
