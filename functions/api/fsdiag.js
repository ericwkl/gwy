/* 临时诊断：飞书抓取在 Cloudflare 环境下的实际行为 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export async function onRequestGet({ request }) {
  const qs = new URL(request.url).searchParams;
  const target = qs.get('url');
  const out = { target, steps: [] };
  try {
    const r = await fetch(target, {
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
    });
    out.status = r.status;
    out.finalUrl = r.url;
    out.redirected = r.redirected;
    const html = await r.text();
    out.bytes = html.length;
    out.titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    out.hasAceLine = /ace-line/.test(html);
    out.hasRenderUnit = /render-unit/.test(html);
    out.hasPageBlock = /page-block/.test(html);
    out.snippet = html.slice(0, 400);
    // 纯文本量
    const txt = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.textLen = txt.length;
    out.textHead = txt.slice(0, 300);
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return new Response(JSON.stringify(out, null, 1), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}
