// A deliberately small Markdown renderer for assistant replies: headings,
// bold, italic, inline code, bullet and numbered lists, paragraphs. It builds
// React nodes (never HTML strings), so nothing in a reply can inject markup.

import React from 'react';

function inline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // **bold**, *italic* or _italic_, `code`
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('**')) out.push(<strong key={k} className="font-semibold">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k} className="px-1 py-0.5 rounded text-[0.92em]" style={{ background: 'rgba(127,127,127,0.18)' }}>{tok.slice(1, -1)}</code>);
    else out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function AgentMarkdown({ text, color }: { text: string; color?: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const k = `p${blocks.length}`;
    blocks.push(
      <p key={k} dir="auto" className="leading-relaxed">
        {para.map((l, i) => (
          <React.Fragment key={i}>{i > 0 && <br />}{inline(l, `${k}-${i}`)}</React.Fragment>
        ))}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const k = `l${blocks.length}`;
    const Tag = list.ordered ? 'ol' : 'ul';
    blocks.push(
      <Tag key={k} dir="auto" className={`${list.ordered ? 'list-decimal' : 'list-disc'} pl-5 space-y-0.5`}>
        {list.items.map((it, i) => <li key={i} className="leading-relaxed">{inline(it, `${k}-${i}`)}</li>)}
      </Tag>,
    );
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flushPara(); flushList();
      const k = `h${blocks.length}`;
      blocks.push(<div key={k} dir="auto" className="font-semibold mt-1">{inline(heading[1], k)}</div>);
    } else if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push((bullet ?? numbered)![1]);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return <div className="space-y-2 text-[13px]" style={{ color }}>{blocks}</div>;
}
