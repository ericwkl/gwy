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
