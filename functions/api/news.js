/* Cloudflare Pages Function —— 同源新闻代理（v2.2.81）
   起因：原公网代理（agentos 沙箱里的 server.mjs）抓广东要闻长期漏条——
   官网 gdywdt/gdyw 列表页 20 条，它只返回 12 条，2026-09-07「省委党校（广东行政学院）
   2026年秋季学期开学典礼举行」等 8 条拿不到。而 gd.gov.cn 不返回 CORS 头，手机 https
   网页无法直连，只能走代理。
   解法：把代理搬进 Cloudflare Pages 自己的 Function，域名与前端同源（gwy-6n1.pages.dev），
   天然无 CORS 问题，也不再依赖外部沙箱（那边会休眠/失联）。
   接口与旧代理保持一致：GET /api/news?src=gd → {ok:true, items:[{t,u,d,s}]} */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const SOURCES = {
  gd: {
    name: '广东要闻',
    cat: 'news',
    url: 'https://www.gd.gov.cn/gdywdt/gdyw/',
    src: '广东省人民政府网',
    parse: parseGd,
  },
};

/* 广东要闻列表页解析。
   页面结构：<li><span class="dot"></span><span class="til"><a href="…post_NNN.html">标题<br/>副标题</a></span><span class="time">2026-09-07</span></li>
   两个要点（旧代理疑似栽在这里）：
   1) <br/> 必须替换成空格再 strip 标签，否则多行标题会粘成一坨或被正则截断；
   2) 标题不做长度截断、不做关键词过滤——官网编辑排的全部照收，过滤交给前端。 */
function parseGd(html) {
  const out = [];
  const re = /<li>\s*<span class="dot"><\/span>\s*<span class="til"><a href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/span>\s*<span class="time"[^>]*>([\d-]{8,10})<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    let url = (m[1] || '').trim();
    if (url.startsWith('//')) url = 'https:' + url;
    else if (!/^https?:/i.test(url)) url = 'https://www.gd.gov.cn' + (url.startsWith('/') ? '' : '/') + url;
    if (!/content\/(m?post)_\d+\.html/.test(url)) continue;
    let t = m[2]
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&ldquo;|&rdquo;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) continue;
    out.push({ t, u: url, d: m[3] || '' });
  }
  return out;
}

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
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      cf: { cacheTtl: 900, cacheEverything: false },
    });
    if (!r.ok) return json({ ok: false, error: 'upstream ' + r.status }, 502);
    const html = await r.text();
    const items = cfg.parse(html).slice(0, limit).map((x) => ({ ...x, s: cfg.src }));
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
