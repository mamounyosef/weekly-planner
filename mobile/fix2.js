const fs = require('fs');
let f = fs.readFileSync('src/screens/Focus.tsx', 'utf8');
let t = fs.readFileSync('src/screens/tmp.tsx', 'utf8');
fs.writeFileSync('src/screens/Focus.tsx', f + t);
