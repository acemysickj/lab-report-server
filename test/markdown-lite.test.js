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

test('pipe table: header/separator/rows, inline formatting in cells', () => {
  const html = markdownToHtml(
    '| 类别 | 内容 |\n| --- | --- |\n| A. 账号 | **邮箱**、密码哈希 |\n| B. 会话 | 令牌哈希 |'
  );
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<thead><tr><th>类别</th><th>内容</th></tr></thead>'));
  assert.ok(html.includes('<tbody>'));
  assert.ok(html.includes('<td><strong>邮箱</strong>、密码哈希</td>'));
  assert.ok(html.includes('<td>令牌哈希</td>'));
  assert.ok(!html.includes('---'), '分隔行不外泄');
});

test('table followed by paragraph terminates rows correctly', () => {
  const html = markdownToHtml('| a | b |\n| - | - |\n| 1 | 2 |\n\n后续段落');
  assert.ok(html.includes('<td>2</td>'));
  assert.ok(html.includes('<p>后续段落</p>'));
  assert.ok(!html.includes('<td>|'), '段落行不被当表行');
});
