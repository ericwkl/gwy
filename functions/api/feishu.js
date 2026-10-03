/* Cloudflare Pages Function —— 同源新闻代理（v2.2.85 扩展）
   起因（v2.2.81）：原公网代理（agentos 沙箱里的 server.mjs）抓广东要闻长期漏条——
   官网列表页 20 条只返回 12 条，2026-09-07「省委党校（广东行政学院）2026年秋季学期
   开学典礼举行」等拿不到。而 gd.gov.cn 不返回 CORS 头，手机 https 网页无法直连，只能走代理。
   解法：把代理搬进 Cloudflare Pages 自己的 Function，与前端同源（gwy-6n1.pages.dev），
   天然无 CORS 问题，也不再依赖外部沙箱（那边会休眠/失联）。

   v2.2.85 扩展说明：此前只实现 gd 一个源，其余源请求同源全返回 "unknown src"，前端只能
   回退公网代理——第一通道对时评类是废的。本次补齐可静态抓取的源：
     gd / rm / plsp / rmsxzh / nfpl
   以下源官网是 JS 动态渲染或需登录态（静态 HTML 抓不到），Function 不做，继续由公网代理兜底：
     gov（www.gov.cn 要闻，TRS 分页脚本渲染）、qs / rmllk（data.people.com.cn 需登录态，直连 500）。
   前端为双通道（同源优先 → 公网代理兜底），缺哪个源不影响整体。

   通用要点（踩坑总结）：
   1) 这类 CMS 列表页的可见文字常被「…」截断，**完整标题只在 <a title="…"> 属性里**，
      必须优先取 title，取不到再退回标签内文本；
   2) <br/> 先替换成空格再 strip 标签，否则多行标题会粘成一坨；
   3) 标题不做长度截断、不做关键词过滤——过滤交给前端。

   接口与旧代理保持一致：GET /api/news?src=gd → {ok:true, items:[{t,u,d,s,digest?}]} */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* ---------- 通用工具 ---------- */

/** 去掉 HTML 标签与实体，压缩空白 */
function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 相对链接补全为绝对链接 */
function absUrl(href, base) {
  let u = String(href || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:/i.test(u)) return u;
  try { return new URL(u, base).href; } catch (e) { return ''; }
}

/** 从链接里取日期 YYYY-MM-DD（人民网系：/n1/YYYY/MMDD/cNNN-NNN.html） */
function dateFromUrl(url) {
  const s = String(url || '');
  let m = s.match(/\/n1\/(20\d{2})\/(\d{2})(\d{2})\//);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/\/(20\d{2})[-/]?(\d{2})[-/]?(\d{2})?/);
  if (!m) return '';
  return m[1] + '-' + m[2] + (m[3] ? '-' + m[3] : '');
}

/** 从 <a …> 标签串里取标题：优先 title 属性，其次标签内文本 */
function titleOf(aTagInner, tagHtml) {
  const tm = tagHtml.match(/\btitle\s*=\s*"([^"]*)"/i) || tagHtml.match(/\btitle\s*=\s*'([^']*)'/i);
  const fromTitle = tm ? stripTags(tm[1]) : '';
  if (fromTitle && fromTitle.length >= 6) return fromTitle;
  return stripTags(aTagInner);
}

/** 通用列表解析：按链接特征抓 <a>，标题优先取 title 属性 */
function parseByLink(html, opts) {
  const { hrefRe, base, minLen = 6, max = 30, accept } = opts;
  const out = [];
  const seen = new Set();
  // 抓 <a …>…</a>，保留开标签（含 title）与内部文本
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const hrefM = attrs.match(/\bhref\s*=\s*"([^"]*)"/i) || attrs.match(/\bhref\s*=\s*'([^']*)'/i);
    if (!hrefM) continue;
    const url = absUrl(hrefM[1], base);
    if (!url || !hrefRe.test(url)) continue;
    const t = titleOf(m[2], attrs);
    if (!t || t.length < minLen) continue;
    if (/^(查看详情|更多|下一页|上一页|返回|首页)$/.test(t)) continue;
    if (accept && !accept(t, url)) continue;
    const key = url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ t, u: url, d: dateFromUrl(url) });
    if (out.length >= max) break;
  }
  return out;
}

/* ---------- 各源解析 ---------- */

/* 广东要闻（gd.gov.cn）：列表结构固定，用专用正则 + <br/> 替换 */
function parseGd(html) {
  const out = [];
  const re = /<li>\s*<span class="dot"><\/span>\s*<span class="til"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/span>\s*<span class="time"[^>]*>([\d-]{8,10})<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = absUrl(m[1], 'https://www.gd.gov.cn');
    if (!/content\/(m?post)_\d+\.html/.test(url)) continue;
    const t = stripTags(m[2]);
    if (!t) continue;
    out.push({ t, u: url, d: m[3] || '' });
  }
  return out;
}

/* 人民网观点频道（opinion.people.com.cn）：/n1/YYYY/MMDD/cNNNNN-NNN.html */
function parseRm(html) {
  return parseByLink(html, {
    hrefRe: /\/n1\/20\d{2}\/\d{4}\/c\d+-\d+\.html$/,
    base: 'http://opinion.people.com.cn/',
    minLen: 6,
  });
}

/* 人民时评（栏目页 GB/8213/49160/49219）：该页 30 条均为 c461529 频道的人民时评，
   标题有的带「（人民时评）」后缀、有的不带，故不做标题过滤，整页收下。 */
function parsePlsp(html) {
  return parseByLink(html, {
    hrefRe: /\/n1\/20\d{2}\/\d{4}\/c461529-\d+\.html$/,
    base: 'http://opinion.people.com.cn/',
    minLen: 6,
  });
}

/* 思想纵横（theory.people.com.cn，c40531 频道） */
function parseSxzh(html) {
  return parseByLink(html, {
    hrefRe: /\/n1\/20\d{2}\/\d{4}\/c\d+-\d+\.html$/,
    base: 'http://theory.people.com.cn/',
    minLen: 6,
  });
}

/* 南方日报评论员（news.southcn.com）：标题带「南方日报评论员」 */
function parseNfpl(html) {
  return parseByLink(html, {
    hrefRe: /node_[a-z0-9]+\/[a-f0-9]+\.shtml$/,
    base: 'https://news.southcn.com/',
    minLen: 8,
    accept: (t) => /南方日报评论员/.test(t),
  });
}

/* ---------- 源配置 ---------- */

const SOURCES = {
  gd: {
    name: '广东要闻', cat: 'news', src: '广东省人民政府网',
    url: 'https://www.gd.gov.cn/gdywdt/gdyw/',
    parse: parseGd,
  },
  rm: {
    name: '人民网观点', cat: 'opinion', src: '人民网',
    url: 'http://opinion.people.com.cn/GB/223228/index.html',
    parse: parseRm,
  },
  plsp: {
    name: '人民时评', cat: 'theory', src: '人民时评',
    url: 'http://opinion.people.com.cn/GB/8213/49160/49219/index.html',
    parse: parsePlsp,
  },
  rmsxzh: {
    name: '思想纵横', cat: 'theory', src: '思想纵横',
    url: 'http://theory.people.com.cn/',
    parse: parseSxzh,
  },
  nfpl: {
    name: '南方日报评论员', cat: 'opinion', src: '南方日报评论员',
    url: 'https://news.southcn.com/node_ac2b0b62a4/',
    parse: parseNfpl,
  },
};

/* ---------- 飞书文档抓取（v2.3.10 搬迁） ----------

   起因：飞书文档导入此前依赖外部沙箱代理（agentos）与公共 CORS 代理，
   两者均已不可用（沙箱休眠返 400、allorigins 408、codetabs 522、corsproxy 401），
   导致「导入飞书链接」长期失败。本次把这条通道也搬进 Cloudflare Function。

   ⚠️ 关键踩坑（务必保留这段注释）：
   1) 直接 fetch 飞书文档地址会命中反爬。响应是一条**多跳重定向链**：
        302 → accounts.feishu.cn/accounts/page/login
        302 → login.feishu.cn/accounts/trap
        302 → accounts.feishu.cn/accounts/page/login?no_trap=1
        302 → 原地址?login_redirect_times=1
        302 → 原地址
        200 ← 完整页面（约 1MB，附带若干 Set-Cookie）
      **这条链必须逐跳跟、且每跳都要带上前面收到的 Cookie**，飞书正是靠这些
      Cookie 判断「本次访问已放行」。详见下方 fetchFollowingWithCookies() 的注释：
      · 直接用 fetch(...,{redirect:'follow'}) → CF 环境不回带跨域 Cookie →
        永远停在 login_redirect_times=4 的登录页（实测只有 92KB，正文为 0）。
      · 正确做法：redirect:'manual' + 自建 Cookie 罐逐跳跟链 → 200，1MB，正文完整。
   2) 正文容器类名是 `render-unit` / `page-block`（**没有** docx-content / wiki-content，
      前端旧代码找的类名是错的）。抓不到容器时兜底取整页纯文本再截断。
   3) 匿名可读的文档才能拿到正文；若权限未开匿名，「只读链接」打开后飞书会返回
      一个 HTTP 200 但正文为空的壳页（可见文字往往只有 "Wiki"/"Docs" 几个字），
      此时不能报「网络错误」，要明确提示权限问题。
   4) 【v2.3.11 关键改进】**不要从 HTML 抠正文，要用页面里的结构化文档树。**
      飞书 SSR 页面内联了 `window.DATA = Object.assign({}, window.DATA, { clientVars:
      Object({ data: { block_map: {...} } }) })`，block_map 是「块 ID → 块数据」映射，
      每个块形如：
        { id, version, data: { type:'heading1'|'heading2'|'heading3'|'bullet'|
          'ordered'|'text'|'page', parent_id, children:[块ID...],
          text:{ initialAttributedTexts:{ text:{ "0":"正文" } } } } }
      **这才是文档的真实结构**：层级、类型、编号一目了然，无任何 HTML 噪声。
      之前用 htmlToText 抠 HTML 会出现严重格式退化——因为飞书把「编号」和「内容」
      渲染成**两个独立的 div**（如 `1.` 一个 div、`马哲题：` 另一个 div），
      无脑按标签换行就会把它们拆成两行；子级项目符号「◦」同理，符号与文字分离。
      改为读 block_map 后，输出即与原文档排版一致（见 blockMapToMarkdown）。
      兜底：万一 block_map 结构变了（飞书改版），退回 HTML 抠字，保证不至于全废。
*/

/** 从 HTML 中按大括号配平抽出 block_map 的 JSON 文本（字符串感知，避免误判括号） */
function extractBlockMapJson(html) {
  const s = String(html || '');
  let i = s.indexOf('"block_map"');
  if (i < 0) return '';
  const braceStart = s.indexOf('{', i + '"block_map"'.length);
  if (braceStart < 0) return '';
  let depth = 0, inStr = false, esc = false;
  for (let k = braceStart; k < s.length; k++) {
    const c = s[k];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(braceStart, k + 1);
    }
  }
  return '';
}

/** 取块内纯文本 */
function blockText(d) {
  try {
    const t = d && d.text && d.text.initialAttributedTexts && d.text.initialAttributedTexts.text;
    if (!t) return '';
    // text 是 { "0": "...", "1": "..." } 的拼接形式
    return Object.keys(t)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => t[k])
      .join('');
  } catch (e) {
    return '';
  }
}

/** 把 block_map 文档树转成 Markdown（保持原文档的标题层级与列表缩进）
 *
 * 【为什么最终统一用「数字编号 + 缩进」输出，而不是照搬飞书的 a./b./c.】
 *   工作台的积累页解析器（index.html 约 4968 行）只把 `^\d+[\.、]` 当成「新条目」，
 *   字母编号不认。实测三种输出在前端解析后的效果：
 *     · 照搬交替编号(a./b./c.) → 话题 17 / 条目 56，但条目文本里残留 "a. …" 前缀；
 *     · 统一数字编号           → 话题 17 / 条目 56，文本最干净（编号被前端消费掉）；
 *     · 全 bullet              → 「一、做题方法」被炸成 17 个平铺条目，层级全丢。
 *   所以输出：1./2./3. + 每层 2 空格缩进；前端会按缩进把深层项归到上层条目里，
 *   最终渲染出的层级与编号由工作台自己决定，观感干净。
 *
 *   映射规则：
 *     heading1/2/3 → #/##/###（前端会识别为话题分隔）
 *     ordered → N. （同级递增，bullet/text 不占号）
 *     bullet  → -
 *     text    → 原样一行
 *     page    → 文档根，只取其 children
 */
function blockMapToMarkdown(map) {
  if (!map) return '';
  // 找根块（type==='page'），找不到就挑一个 parent_id 不在 map 里的
  let rootId = null;
  for (const id in map) {
    const d = map[id] && map[id].data;
    if (d && d.type === 'page') { rootId = id; break; }
  }
  if (!rootId) {
    for (const id in map) {
      const d = map[id] && map[id].data;
      if (d && d.parent_id && !map[d.parent_id]) { rootId = id; break; }
    }
  }
  const lines = [];
  const heading = { heading1: '#', heading2: '##', heading3: '###' };

  // 遍历某父块的 children；同层 ordered 兄弟共享递增计数（bullet/text 不占号）
  function walkChildren(kids, depth) {
    let orderedNo = 0;
    for (const cid of kids) {
      const rec = map[cid];
      if (!rec || !rec.data) continue;
      const d = rec.data;
      const type = d.type || 'text';
      const txt = blockText(d);
      const sub = Array.isArray(d.children) ? d.children : [];
      const indent = '  '.repeat(Math.max(0, depth));

      if (heading[type]) {
        // 标题本身用 # 表达，其下内容的缩进层级 +1
        if (txt) lines.push(indent + heading[type] + ' ' + txt);
        walkChildren(sub, depth + 1);
        continue;
      }
      if (type === 'ordered') {
        orderedNo += 1;
        if (txt) lines.push(indent + orderedNo + '. ' + txt);
        walkChildren(sub, depth + 1);
        continue;
      }
      if (type === 'bullet') {
        if (txt) lines.push(indent + '- ' + txt);
        walkChildren(sub, depth + 1);
        continue;
      }
      // text / 其它类型：当普通段落
      if (txt) lines.push(indent + txt);
      walkChildren(sub, depth + 1);
    }
  }

  if (rootId) {
    const root = map[rootId] && map[rootId].data;
    walkChildren(root && Array.isArray(root.children) ? root.children : [], 0);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 从 HTML 抽出结构化文档树并转 Markdown；成功返回字符串，失败返回 '' */
function feishuMarkdownFromBlockMap(html) {
  const raw = extractBlockMapJson(html);
  if (!raw || raw.length < 50) return '';
  let map = null;
  try {
    map = JSON.parse(raw);
  } catch (e) {
    return '';
  }
  if (!map || typeof map !== 'object') return '';
  const md = blockMapToMarkdown(map);
  return md && md.length >= 30 ? md : '';
}

/** 去掉 <script>/<style> 与标签，实体还原，保留换行结构（飞书正文提取用） */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&');
  // 零宽字符（飞书正文里大量 \u200b）清掉，否则会污染标题与行首
  s = s.replace(/[\u200b-\u200f\ufeff]/g, '');
  s = s.replace(/[ \t]+\n/g, '\n');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 从整页 HTML 里抽取飞书文档标题
    ⚠️ 飞书的 <title> 只写死成 "Docs"/"Wiki"，**不是文档名**，别拿它当标题。
    真实标题有两处可靠来源（按优先级）：
      a) 页面内联的 window.__SSR_DOC_INFO__ JSON（含 title 字段），最准；
      b) page-block / render-unit 容器开头的第一段可见文字（紧随容器起始标签）。
*/
function feishuTitleOf(html) {
  const s = String(html || '');
  // a) SSR JSON
  const ssrM = s.match(/__SSR_DOC_INFO__\s*=\s*JSON\.parse\(decodeURIComponent\(\s*'([^']+)'/);
  if (ssrM) {
    try {
      const info = JSON.parse(decodeURIComponent(ssrM[1]));
      const cand = [
        info && info.title,
        info && info.doc_title,
        info && info.data && info.data.title,
        info && info.meta && info.meta.title,
      ].find((x) => typeof x === 'string' && x.trim());
      if (cand) return cand.trim();
    } catch (e) { /* 落到 b) */ }
  }
  // b) 容器开头的可见文字。实测飞书正文首行标题放在 `ace-line` 节点里，
  //    其前面还有编辑器占位符「输入"/"快速插入内容」和作者信息，必须跳过。
  //    所以直接以 ace-line 为锚点取第一行，最稳。
  const aceM = s.match(/class="[^"]*\bace-line\b[^"]*"[^>]*>([\s\S]{0,300}?)<\//i);
  if (aceM) {
    const t = htmlToText(aceM[1]).split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
    if (t && t.length <= 80) return t;
  }
  // c) 退一步：容器开头片段里挑第一个像标题的行
  const cM =
    s.match(/<div[^>]+class="[^"]*\bpage-block\b[^"]*"[^>]*>([\s\S]{0,1500}?)(?:<\/h1>|<\/div>\s*<div)/i) ||
    s.match(/<div[^>]+class="[^"]*\brender-unit\b[^"]*"[^>]*>([\s\S]{0,1500}?)(?:<\/h1>|<\/div>\s*<div)/i);
  if (cM) {
    const lines = htmlToText(cM[1]).split('\n').map((x) => x.trim()).filter(Boolean);
    const t = lines.find(
      (x) =>
        x.length <= 60 &&
        !/^输入\s*[“"]?\s*\/\s*[”"]?\s*快速插入内容$/.test(x) &&
        !/^(用户\d+|匿名用户|\d+月\d+日(修改)?|分享|评论|点赞)/.test(x)
    );
    if (t) return t;
  }
  // 兜底才用 <title>，并剥掉平台后缀
  const m = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let t = m ? stripTags(m[1]) : '';
  t = t.replace(/\s*[-—|·]\s*(飞书|Feishu|Lark|云文档|Docs).*$/i, '').trim();
  return /^(docs|wiki|飞书|feishu|lark)$/i.test(t) ? '' : t;
}

/** 手工跟链 + Cookie 罐 抓取飞书页面
 *
 * ⚠️⚠️ 这是本功能最关键、也最容易踩错的一步，务必读完再改 ⚠️⚠️
 *
 * 为什么不能用 fetch(url,{redirect:'follow'}) 了事？
 *   实测（Cloudflare Pages Function 线上环境）：
 *     · fetch(url,{redirect:'follow'})  → 最终停在
 *         accounts.feishu.cn/accounts/page/login?...&login_redirect_times=4
 *       只有 92KB 的登录页，正文一个字都拿不到。
 *   Python 对照实验（同一 URL、同一 UA）：
 *     · 带 CookieJar（每跳自动回带 Cookie） → 200，1,061,173 字节，正文完整 ✓
 *     · 不带 Cookie                         → 抛 "infinite loop" 错误 ✗
 *   结论：**飞书是靠登录跳转链路上的 Set-Cookie 来判断「这次访问已放行」的。**
 *   而 CF 的 fetch 在跨域重定向时**不会自动持久化、也不会回带 Cookie**，
 *   于是每一跳都被当成新访客，重新踢回登录页，最终停死在登录页。
 *
 * 解法：自己实现一个极简 Cookie 罐，手动跟 302：
 *   1) redirect:'manual' 逐跳处理，每跳读 Set-Cookie 存进 jar；
 *   2) 下一跳把 jar 里同域（含父域）的 Cookie 拼成 Cookie 头带上；
 *   3) 最多跟 12 跳（实测链长约 5~7 跳），防死循环；
 *   4) 拿到 2xx 就返回 HTML 全文。
 * 注意 Set-Cookie 可能有多条，Headers.getSetCookie() 可用时优先用它。
 */
function cookieHeaderFrom(jar, urlStr) {
  let host = '';
  try { host = new URL(urlStr).hostname; } catch (e) { return ''; }
  const parts = [];
  for (const c of jar) {
    // 简化域匹配：精确域 或 父域后缀（飞书自身 cookie 基本是 .feishu.cn 级）
    if (host === c.domain || host.endsWith(c.domain.replace(/^\./, ''))) {
      parts.push(c.name + '=' + c.value);
    }
  }
  return parts.join('; ');
}

function absorbSetCookies(jar, res, urlStr) {
  let host = '';
  try { host = new URL(urlStr).hostname; } catch (e) { return; }
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') {
    list = res.headers.getSetCookie();
  } else {
    const raw = res.headers.get('set-cookie');
    if (raw) list = raw.split(/,(?=[^;,]+=)/g);
  }
  for (const line of list) {
    const kv = String(line).split(';')[0].trim();
    const eq = kv.indexOf('=');
    if (eq <= 0) continue;
    const name = kv.slice(0, eq).trim();
    const value = kv.slice(eq + 1).trim();
    if (!name) continue;
    // 取 Domain 属性，缺省按当前 host
    const dm = String(line).match(/;\s*Domain=([^;]+)/i);
    const domain = dm ? dm[1].trim().toLowerCase() : host;
    const old = jar.findIndex((c) => c.name === name && c.domain === domain);
    const rec = { name, value, domain };
    if (old >= 0) jar[old] = rec; else jar.push(rec);
  }
}

async function fetchFollowingWithCookies(startUrl) {
  const jar = [];
  let cur = startUrl;
  for (let hop = 0; hop < 12; hop++) {
    const headers = {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
    };
    const ck = cookieHeaderFrom(jar, cur);
    if (ck) headers.cookie = ck;

    const res = await fetch(cur, { redirect: 'manual', headers });
    absorbSetCookies(jar, res, cur);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return await res.text();
      cur = new URL(loc, cur).href;
      continue;
    }
    // 2xx（或其它终态）→ 直接读全文
    return await res.text();
  }
  return null; // 超过跳数上限，视为失败
}

/** 判断飞书返回的是不是「无内容壳页」（多为权限未开匿名 / 文档不存在） */
function feishuLooksEmpty(html, text) {
  const t = String(text || '').trim();
  if (t.length < 40) return true;
  // 壳页特征：可见文本极短且只含 Wiki / Docs / 登录 等词
  if (t.length < 120 && /^(wiki|docs|飞书|feishu|文档)?[\s\S]{0,20}$/i.test(t)) return true;
  if (/<title[^>]*>\s*(Wiki|Docs|飞书|Feishu)\s*<\/title>/i.test(html) && t.length < 200) return true;
  return false;
}

/** 抓取飞书文档，返回 {ok,title,content,error} */
async function fetchFeishu(target) {
  let u;
  try {
    u = new URL(target);
  } catch (e) {
    return { ok: false, error: '链接格式不正确' };
  }
  if (!/(^|\.)(feishu\.cn|larksuite\.com|feishu\.net)$/i.test(u.hostname)) {
    return { ok: false, error: '只支持飞书文档链接（feishu.cn / larksuite.com）' };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, error: '只支持 http(s) 链接' };

  let html = '';
  try {
    html = await fetchFollowingWithCookies(u.href);
  } catch (e) {
    return { ok: false, error: '抓取失败（网络不可达）：' + String((e && e.message) || e) };
  }
  if (!html) return { ok: false, error: '抓取失败（上游无响应）' };

  const title = feishuTitleOf(html);

  // 【首选】结构化文档树 → Markdown（格式与原文档一致）
  let content = feishuMarkdownFromBlockMap(html);
  let source = content ? 'block_map' : '';

  // 【兜底】HTML 抠字（飞书改版导致 block_map 结构变化时用）
  if (!content) {
    const containers = [
      /<div[^>]+class="[^"]*\brender-unit\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
      /<div[^>]+class="[^"]*\bpage-block\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    ];
    for (const re of containers) {
      const m = html.match(re);
      if (m) {
        const t = htmlToText(m[1]);
        if (t.length > content.length) content = t;
      }
      if (content.length >= 80) break;
    }
    if (content.length < 80) {
      // 再兜底：整页纯文本（会把导航词带进来，所以再按首个正文标志截取）
      let all = htmlToText(html);
      const anchor = all.search(/(输入\s*[“"]?\s*\/\s*[”"]?\s*快速插入内容|一、|前言|方法)/);
      if (anchor > 0 && anchor < 600) all = all.slice(anchor);
      if (all.length > content.length) content = all;
    }
    content = content.replace(/\n{3,}/g, '\n\n').trim();

    // 清理正文头部的编辑器噪声：占位符 / 作者名 / 修改时间 / 工具条词
    content = content
      .split('\n')
      .filter((ln) => {
        const x = ln.trim();
        if (!x) return true;
        if (/^输入\s*[“"]?\s*\/\s*[”"]?\s*快速插入内容$/.test(x)) return false;
        if (/^(Docs|Wiki|分享|问问豆包|最近修改|评论|点赞|收藏)$/.test(x)) return false;
        if (/^(用户\d+|匿名用户)$/.test(x)) return false;
        if (/^\d+月\d+日(修改)?$/.test(x)) return false;
        return true;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (content) source = 'html';
  }

  if (feishuLooksEmpty(html, content)) {
    return {
      ok: false,
      error:
        '文档没有匿名阅读权限（或链接失效）。请在飞书里把该文档设为「互联网上获得链接的人可阅读」，再重新抓取。',
    };
  }
  return { ok: true, title, content, source };
}

/* ---------- 入口 ---------- */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=900',
    },
  });
}

export async function onRequestGet({ request }) {
  const qs = new URL(request.url).searchParams;

  // 飞书文档抓取：GET /api/feishu?url=<encoded feishu url>
  const feishuUrl = qs.get('url');
  if (feishuUrl && /feishu\.cn|larksuite\.com/i.test(feishuUrl)) {
    const res = await fetchFeishu(feishuUrl);
    if (!res.ok) return json({ ok: false, error: res.error }, 200);
    return json({ ok: true, title: res.title || '', content: res.content });
  }

  const src = (qs.get('src') || '').toLowerCase();
  const cfg = SOURCES[src];
  if (!cfg) return json({ ok: false, error: 'unknown src: ' + src }, 400);

  const limit = Math.min(40, Math.max(1, parseInt(qs.get('limit') || '20', 10) || 20));
  try {
    const r = await fetch(cfg.url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      cf: { cacheTtl: 900, cacheEverything: false },
    });
    if (!r.ok) return json({ ok: false, error: 'upstream ' + r.status }, 502);
    const html = await r.text();
    const items = cfg.parse(html)
      .slice(0, limit)
      .map((x) => ({ t: x.t, u: x.u, d: x.d || '', s: x.s || cfg.src, ...(x.digest ? { digest: x.digest } : {}) }));
    return json({
      ok: true,
      name: cfg.name,
      cat: cfg.cat,
      src: 'cloudflare-pages-function',
      fetchTime: new Date().toISOString(),
      count: items.length,
      items,
    });
  } catch (e) {
    return json({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}
