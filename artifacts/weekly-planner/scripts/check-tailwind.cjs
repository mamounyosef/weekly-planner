const fs = require('fs');
const path = require('path');

function getFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) { 
      results = results.concat(getFiles(file));
    } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
      results.push(file);
    }
  });
  return results;
}

const files = getFiles('d:/My Projects/weekly-planner/artifacts/weekly-planner/src');
const words = new Set();
files.forEach(f => {
  const content = fs.readFileSync(f, 'utf8');
  // Just find anything that looks like a tailwind class
  const matches = content.match(/className=["']([^"']+)["']/g) || [];
  const matches2 = content.match(/className=\{`([^`]+)`\}/g) || [];
  
  matches.concat(matches2).forEach(m => {
    const str = m.replace(/className=(["'\{`]+)/, '').replace(/(["'\}`]+)$/, '');
    const cls = str.split(/\s+/);
    cls.forEach(c => words.add(c));
  });
});
const wordList = Array.from(words);

const suspects = wordList.filter(w => 
  w.includes('gray') || w.includes('boder') || w.startsWith('clx') || w.startsWith('pading') || w.startsWith('margn')
);
console.log("Suspects:", suspects);

const counts = {};
wordList.forEach(w => {
  const prefix = w.split('-')[0];
  counts[prefix] = (counts[prefix] || 0) + 1;
});
console.log("Common prefixes to check for typos:");
Object.entries(counts).filter(([k,v]) => v === 1).forEach(([k]) => console.log(k));
