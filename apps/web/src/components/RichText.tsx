import { Fragment, type ReactNode } from 'react';

/**
 * Light Markdown for what digital employees report: headings, fenced code, bullet and numbered lists,
 * `inline code` and **bold**. Everything becomes React elements, so text can never inject HTML.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  return <div className={className ? `rich-text ${className}` : 'rich-text'}>{blocks(text)}</div>;
}

function blocks(text: string): ReactNode[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushParagraph = () => {
    if (paragraph.length) out.push(<p key={out.length}>{inline(paragraph.join('\n'))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((item, index) => <li key={index}>{inline(item)}</li>);
    out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```/.exec(line);
    if (fence) {
      flushParagraph(); flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push(<pre key={out.length}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(heading[1]!.length + 2, 6);
      const Tag = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6';
      out.push(<Tag key={out.length}>{inline(heading[2]!)}</Tag>);
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = !bullet;
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    flushList();
    paragraph.push(line);
  }
  flushParagraph(); flushList();
  return out;
}

function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index!;
    if (at > last) parts.push(<Fragment key={parts.length}>{text.slice(last, at)}</Fragment>);
    parts.push(match[1] !== undefined ? <code key={parts.length}>{match[1]}</code> : <strong key={parts.length}>{match[2]}</strong>);
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={parts.length}>{text.slice(last)}</Fragment>);
  return parts;
}
