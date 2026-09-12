// src/lib/markdown-lite.js — 极简 Markdown→HTML（DOM-003，法务文档专用）
// 法律文档只用得到：标题/粗体/斜体/行内代码/链接/水平线/有序无序列表/引用/段落。
// 内置转换器，不加依赖（仓库依赖纪律）；输出是拼装前的片段，由 legal.js 包进页面骨架。
// 安全：正文来自服务端自己的 docs/legal/*.md（非用户输入），仍做最小转义（< > &）防意外注入。

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 行内元素：`code`、**bold**、*italic*、[text](url)（http(s) 与站内路径限定，防 javascript:）。 */
function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    if (!/^(https?:\/\/|mailto:|\/)/i.test(url)) return m; // 非白名单协议原样保留
    return `<a href="${url}">${label}</a>`;
  });
  return s;
}

// ---- GFM 管道表（隐私政策 §2/§3）----

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isTableSeparator(line) {
  if (typeof line !== 'string' || !line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c)); // GFM：≥1 个 -
}

/** 块级转换：逐行状态机，支持 h1-h3/ul/ol/blockquote/hr/管道表/段落。h4+ 法律文档未用，按段落处理。 */
export function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = null; // 'ul' | 'ol' —— 列表类型切换时先闭合再开新
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    // 管道表：本行含 | 且下一行是分隔行（|---|---|）→ 整表消费
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      closeList();
      const header = splitTableRow(line);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim() && lines[j].includes('|')) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      const th = header.map((c) => `<th>${renderInline(c)}</th>`).join('');
      const trs = rows
        .map((r) => `<tr>${header.map((_, idx) => `<td>${renderInline(r[idx] ?? '')}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`);
      i = j - 1;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].replace(/#+\s*$/, ''))}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph();
      closeList();
      out.push('<hr>');
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line.trim());
    if (ul) {
      flushParagraph();
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${renderInline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\d+[.、]\s+(.*)$/.exec(line.trim());
    if (ol) {
      flushParagraph();
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${renderInline(ol[1])}</li>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  closeList();
  return out.join('\n');
}
