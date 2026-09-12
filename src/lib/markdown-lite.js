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

/** 块级转换：逐行状态机，支持 h1-h3/ul/ol/blockquote/hr/段落。h4+ 法律文档未用，按段落处理。 */
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

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushParagraph();
      closeList();
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
