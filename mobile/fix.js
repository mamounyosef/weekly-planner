const fs = require('fs');
let c = fs.readFileSync('src/screens/Focus.tsx', 'utf8');
c = c.replace(/function niceDate[\s\S]*$/, `function niceDate(date: string | undefined): string {
  if (!date) return '';
  return new Date(\`\${date}T00:00:00\`)
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
`);
fs.writeFileSync('src/screens/Focus.tsx', c);
