// A small markdown reader for the assistant's replies: headings, bullet and numbered lists, paragraphs,
// **bold**, *italic* and `code`. It builds React elements from text (never HTML), so a reply cannot
// inject markup, links or scripts into the page.
import type { ReactNode } from 'react';

type Block = { kind: 'h'; text: string } | { kind: 'p'; text: string } | { kind: 'ul' | 'ol'; items: string[] };

function blocks(src: string): Block[] {
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      out.push({ kind: 'h', text: h[1] });
    } else if (ul || ol) {
      flush();
      const kind = ul ? 'ul' : 'ol';
      const last = out[out.length - 1];
      const item = (ul ?? ol)![1];
      if (last && last.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
    } else {
      // a line made only of bold text reads as a heading ("**What the file holds**")
      const bold = /^\s*\*\*([^*]+)\*\*:?\s*$/.exec(line);
      if (bold) {
        flush();
        out.push({ kind: 'h', text: bold[1] });
        continue;
      }
      const last = out[out.length - 1];
      // a wrapped continuation of a list item
      if (!para.length && last && (last.kind === 'ul' || last.kind === 'ol') && /^\s{2,}\S/.test(raw)) last.items[last.items.length - 1] += ` ${line.trim()}`;
      else para.push(line.trim());
    }
  }
  flush();
  return out;
}

/** Inline marks: `code`, **bold**, *italic* / _italic_. */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])/g;
  let at = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1] !== undefined) out.push(<code key={k++}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<b key={k++}>{m[2]}</b>);
    else out.push(<i key={k++}>{m[3] ?? m[4]}</i>);
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

export function Md({ text }: { text: string }) {
  return (
    <div className="md">
      {blocks(text).map((b, i) =>
        b.kind === 'h' ? (
          <div key={i} className="md-h">
            {inline(b.text)}
          </div>
        ) : b.kind === 'p' ? (
          <p key={i}>{inline(b.text)}</p>
        ) : b.kind === 'ul' ? (
          <ul key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ul>
        ) : (
          <ol key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}
