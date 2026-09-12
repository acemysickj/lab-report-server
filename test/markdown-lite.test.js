// test/markdown-lite.test.js — DOM-003 极简转换器：法务文档够用 + 最小安全面
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from '../src/lib/markdown-lite.js';

test('headings, bold, hr, paragraphs', () => {
  const html = markdownToHtml('# 标题\n\n正文**加粗**继续\n\n---\n\n尾段');
  assert.ok(html.includes('<h1>标题</h1>'));
  assert.ok(html.includes('<strong>加粗</strong>'));
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('<p>尾段</p>'));
});

test('lists: ul/ol switch closes previous; ordered with Chinese separator', () => {
  const html = markdownToHtml('- 甲\n- 乙\n\n1. 第一\n2. 第二');
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<li>甲</li>'));
  assert.ok(html.includes('</ul>'));
  assert.ok(html.includes('<ol>'));
  assert.ok(html.includes('<li>第一</li>'));
});

test('links: http/mailto allowed, javascript: scheme left literal', () => {
  const html = markdownToHtml('[官网](https://lab-report.top) [邮](mailto:a@b.c) [坏](javascript:alert(1))');
  assert.ok(html.includes('<a href="https://lab-report.top">官网</a>'));
  assert.ok(html.includes('<a href="mailto:a@b.c">邮</a>'));
  assert.ok(!html.includes('<a href="javascript:'), 'javascript: 不生成链接');
});

test('escaping: < > & in source are escaped', () => {
  const html = markdownToHtml('a <b> & c');
  assert.ok(html.includes('&lt;b&gt;'));
  assert.ok(html.includes('&amp;'));
});

test('blockquote and blank-line separation', () => {
  const html = markdownToHtml('> 引用一句\n\n段落');
  assert.ok(html.includes('<blockquote>引用一句</blockquote>'));
  assert.ok(html.includes('<p>段落</p>'));
});
