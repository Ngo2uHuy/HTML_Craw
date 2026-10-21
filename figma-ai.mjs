// Figma -> HTML/CSS/JS bằng AI (Gemini / Claude / Codex-OpenAI).
// Gửi ảnh chụp frame + cây node rút gọn + danh sách asset đã tải, nhận về { html, css, js }.
import { prepareFigma, saveIndex, visible, rgba, round, escHtml, linkOf, addFont, fontLinks } from './figma.mjs';

export const PROVIDERS = {
  gemini: { label: 'Gemini', env: 'GEMINI_API_KEY', defaultModel: 'gemini-2.5-pro' },
  claude: { label: 'Claude', env: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5-5' },
  openai: { label: 'Codex (OpenAI)', env: 'OPENAI_API_KEY', defaultModel: 'gpt-5-codex' },
};

const MAX_TOKENS = 64000;
const SCHEMA = {
  type: 'object',
  properties: { html: { type: 'string' }, css: { type: 'string' }, js: { type: 'string' } },
  required: ['html', 'css', 'js'],
  additionalProperties: false,
};

const SYSTEM = `You are a senior front-end engineer who turns Figma designs into production-quality static websites.
You receive a screenshot of one Figma frame plus a simplified JSON node tree of that frame.
Write clean, semantic, responsive HTML5 + modern CSS + vanilla JavaScript that reproduces the design faithfully.

Rules:
- Match the screenshot visually at the design width; use flexbox/grid (not absolute positioning) except for true overlays.
- Make it responsive down to 375px wide with media queries.
- Use the exact text content from the node tree. Keep the original language.
- Use images and icons ONLY through the relative asset paths provided. Never invent external image URLs. Decorative shapes without an asset may be drawn with CSS.
- Use the given font families; the host page already loads them.
- Nodes with a "link" field must be <a href> to that value.
- Add vanilla JS only for interactions the design implies (mobile nav toggle, tabs, sliders, accordions...). Use "" when none is needed.
- Class names in kebab-case. No frameworks, no CDN scripts.

Return a JSON object {"html": string, "css": string, "js": string}:
- "html": only the markup that goes inside <body> (no <html>, <head>, <body>, <link> or <script> tags).
- "css": the complete stylesheet, including a small reset.
- "js": the complete script.`;

// ---------- node tree ----------
function summarizePaint(p, assetPaths) {
  if (p.type === 'SOLID') return rgba(p.color, p.opacity ?? 1);
  if (p.type === 'IMAGE') return `image ${assetPaths.get(p.imageRef) || '(missing)'} ${(p.scaleMode || 'FILL').toLowerCase()}`;
  if (p.type.startsWith('GRADIENT_')) {
    return `${p.type.slice(9).toLowerCase()}-gradient(${(p.gradientStops || []).map(s => `${rgba(s.color)} ${round(s.position * 100)}%`).join(', ')})`;
  }
  return p.type.toLowerCase();
}

function simplify(n, parent, ctx) {
  if (n.visible === false || n.isMask) return null;
  const b = n.absoluteBoundingBox || { x: 0, y: 0, width: 0, height: 0 };
  const pb = parent?.absoluteBoundingBox || b;
  const o = { type: n.type, name: n.name, box: [round(b.x - pb.x), round(b.y - pb.y), round(b.width), round(b.height)] };
  const link = linkOf(n, ctx.pageFiles);
  if (link) o.link = link;
  if (n.opacity != null && n.opacity < 1) o.opacity = round(n.opacity);
  if (ctx.graphic.has(n.id)) {
    o.type = 'ICON';
    o.src = ctx.assetPaths.get(n.id) || null;
    return o;
  }
  const fills = visible(n.fills).map(p => summarizePaint(p, ctx.assetPaths));
  if (n.type === 'TEXT') {
    const s = n.style || {};
    o.text = n.characters;
    o.font = `${s.fontFamily} ${s.fontWeight || 400} ${round(s.fontSize || 16)}px/${s.lineHeightPx ? `${round(s.lineHeightPx)}px` : 'normal'}`;
    if (s.letterSpacing) o.letterSpacing = round(s.letterSpacing);
    if (s.textAlignHorizontal && s.textAlignHorizontal !== 'LEFT') o.align = s.textAlignHorizontal.toLowerCase();
    if (s.textCase && s.textCase !== 'ORIGINAL') o.textCase = s.textCase.toLowerCase();
    if (s.textDecoration && s.textDecoration !== 'NONE') o.decoration = s.textDecoration.toLowerCase();
    if (fills.length) o.color = fills[0];
    addFont(ctx.fonts, s);
    for (const st of Object.values(n.styleOverrideTable || {})) addFont(ctx.fonts, { fontFamily: st.fontFamily || s.fontFamily, fontWeight: st.fontWeight });
    return o;
  }
  if (fills.length) o.fills = fills;
  if (n.layoutMode && n.layoutMode !== 'NONE') {
    o.layout = {
      dir: n.layoutMode.toLowerCase(), gap: n.itemSpacing || 0,
      pad: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(v => round(v || 0)),
      justify: (n.primaryAxisAlignItems || 'MIN').toLowerCase(), align: (n.counterAxisAlignItems || 'MIN').toLowerCase(),
      ...(n.layoutWrap === 'WRAP' ? { wrap: true } : {}),
    };
  }
  if (parent?.layoutMode && parent.layoutMode !== 'NONE' && n.layoutSizingHorizontal) {
    o.sizing = `${n.layoutSizingHorizontal.toLowerCase()}/${n.layoutSizingVertical.toLowerCase()}`;
  }
  if (n.cornerRadius) o.radius = round(n.cornerRadius);
  else if (n.rectangleCornerRadii) o.radius = n.rectangleCornerRadii.map(round);
  const stroke = visible(n.strokes)[0];
  if (stroke && n.strokeWeight) o.stroke = `${round(n.strokeWeight)}px ${summarizePaint(stroke, ctx.assetPaths)}`;
  const fx = visible(n.effects).map(e => `${e.type.toLowerCase()}${e.offset ? ` ${round(e.offset.x)} ${round(e.offset.y)}` : ''} r${round(e.radius || 0)}${e.color ? ` ${rgba(e.color)}` : ''}`);
  if (fx.length) o.effects = fx;
  if (n.clipsContent) o.clip = true;
  const kids = visible(n.children).map(c => simplify(c, n, ctx)).filter(Boolean);
  if (kids.length) o.children = kids;
  return o;
}

// ---------- providers ----------
async function* sse(res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
}

async function ensureOk(res, label) {
  if (res.ok) return res;
  const body = await res.text();
  let msg = body;
  try { const j = JSON.parse(body); msg = j.error?.message || j.message || body; } catch {}
  throw new Error(`${label} API ${res.status}: ${String(msg).slice(0, 300)}`);
}

const CALLS = {
  async gemini({ key, model, text, image, signal, onDelta }) {
    const res = await ensureOk(await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ inlineData: { mimeType: image.mime, data: image.data } }, { text }] }],
          generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 65536 },
        }),
      }), 'Gemini');
    let out = '', finish = '';
    for await (const e of sse(res)) {
      if (e.promptFeedback?.blockReason) throw new Error(`Gemini chặn yêu cầu: ${e.promptFeedback.blockReason}`);
      const c = e.candidates?.[0];
      for (const p of c?.content?.parts || []) if (p.text && !p.thought) { out += p.text; onDelta(out.length); }
      if (c?.finishReason) finish = c.finishReason;
    }
    if (finish === 'MAX_TOKENS') throw new Error('Gemini: output bị cắt vì quá dài (MAX_TOKENS)');
    if (finish && finish !== 'STOP') throw new Error(`Gemini dừng: ${finish}`);
    return out;
  },

  async claude({ key, model, text, image, signal, onDelta }) {
    // fallbacks/effort chỉ có trên các model đời mới; model cũ sẽ 400 nếu gửi.
    const modern = /^claude-(fable|opus|sonnet|haiku)-5/.test(model);
    const fallback = /^claude-(fable-5-1|opus-5|sonnet-5-5)/.test(model);
    const res = await ensureOk(await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: {
        'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
        ...(fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}),
      },
      body: JSON.stringify({
        model, max_tokens: MAX_TOKENS, stream: true, system: SYSTEM,
        ...(fallback ? { fallbacks: 'default' } : {}),
        output_config: { ...(modern ? { effort: 'high' } : {}), format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } },
            { type: 'text', text },
          ],
        }],
      }),
    }), 'Claude');
    let out = '', stop = '';
    for await (const e of sse(res)) {
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') { out += e.delta.text; onDelta(out.length); }
      else if (e.type === 'message_delta' && e.delta?.stop_reason) stop = e.delta.stop_reason;
      else if (e.type === 'error') throw new Error(`Claude: ${e.error?.message || 'stream error'}`);
    }
    if (stop === 'refusal') throw new Error('Claude từ chối yêu cầu (refusal)');
    if (stop === 'max_tokens') throw new Error('Claude: output bị cắt vì quá dài (max_tokens)');
    return out;
  },

  async openai({ key, model, text, image, signal, onDelta }) {
    const res = await ensureOk(await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, stream: true, instructions: SYSTEM, max_output_tokens: MAX_TOKENS,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text },
            { type: 'input_image', image_url: `data:${image.mime};base64,${image.data}` },
          ],
        }],
        text: { format: { type: 'json_schema', name: 'web_page', strict: true, schema: SCHEMA } },
      }),
    }), 'OpenAI');
    let out = '';
    for await (const e of sse(res)) {
      if (e.type === 'response.output_text.delta') { out += e.delta; onDelta(out.length); }
      else if (e.type === 'response.incomplete') throw new Error(`OpenAI: output chưa xong (${e.response?.incomplete_details?.reason || 'incomplete'})`);
      else if (e.type === 'response.failed') throw new Error(`OpenAI: ${e.response?.error?.message || 'failed'}`);
      else if (e.type === 'error') throw new Error(`OpenAI: ${e.message || 'stream error'}`);
    }
    return out;
  },
};

export async function listModels(provider, key) {
  if (provider === 'gemini') {
    const r = await (await ensureOk(await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } }), 'Gemini')).json();
    return (r.models || []).filter(m => m.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(m.name))
      .map(m => m.name.replace(/^models\//, ''));
  }
  if (provider === 'claude') {
    const r = await (await ensureOk(await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }), 'Claude')).json();
    return (r.data || []).map(m => m.id);
  }
  const r = await (await ensureOk(await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${key}` } }), 'OpenAI')).json();
  return (r.data || []).map(m => m.id).filter(id => /codex|^gpt-[45]|^o\d/.test(id)).sort().reverse();
}

export const resolveAiKey = (provider, key) => String(key || '').trim() || process.env[PROVIDERS[provider]?.env] || '';

function parseResult(raw) {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  let r;
  try { r = JSON.parse(s); } catch { throw new Error('AI trả về JSON không hợp lệ'); }
  if (typeof r.html !== 'string' || !r.html.trim()) throw new Error('AI không trả về HTML');
  return { html: r.html, css: String(r.css || ''), js: String(r.js || '') };
}

// ---------- main ----------
export async function figmaToHtmlAI({ url, token, out, provider, model, aiKey, prompt, signal, onEvent }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Provider không hỗ trợ: ${provider}`);
  const key = resolveAiKey(provider, aiKey);
  if (!key) throw new Error(`Thiếu API key ${p.label} (nhập ở form hoặc đặt ${p.env})`);
  model ||= p.defaultModel;

  const ctx = await prepareFigma({ url, token, out, signal, onEvent });
  const { key: fileKey, OUT, stats, emit, get, save, frames, graphic, assetPaths, pageFiles } = ctx;
  await saveIndex(save, fileKey, frames, pageFiles);

  for (const f of frames) {
    signal?.throwIfAborted();
    const file = pageFiles.get(f.id);
    const base = file.replace(/\.html$/, '');
    const b = f.absoluteBoundingBox || { width: 1440, height: 900 };

    // Ảnh chụp frame: giới hạn cạnh dài ~4000px để vừa giới hạn ảnh của các API.
    emit('page', { url: `Chụp ảnh frame "${f.name}"` });
    const scale = round(Math.min(1, 4000 / Math.max(b.width, b.height)));
    const { images = {} } = await get(`/images/${fileKey}?ids=${encodeURIComponent(f.id)}&format=jpg&scale=${scale}`);
    if (!images[f.id]) throw new Error(`Figma không xuất được ảnh frame "${f.name}"`);
    const shot = await fetch(images[f.id], { signal });
    if (!shot.ok) throw new Error(`Tải ảnh frame lỗi HTTP ${shot.status}`);
    const image = { mime: 'image/jpeg', data: Buffer.from(await shot.arrayBuffer()).toString('base64') };

    const fonts = new Map();
    const tree = simplify(f, null, { graphic, assetPaths, pageFiles, fonts });
    const assets = [...assetPaths.values()];
    const text = [
      `Frame: "${f.name}" — design width ${round(b.width)}px, height ${round(b.height)}px.`,
      `Available assets (relative paths from the page): ${assets.length ? assets.join(', ') : 'none'}.`,
      `Fonts: ${[...fonts.keys()].join(', ') || 'system-ui'}.`,
      prompt ? `Extra requirements from the user: ${prompt}` : '',
      'Node tree (box = [x, y, width, height] relative to parent):',
      JSON.stringify(tree),
    ].filter(Boolean).join('\n');

    emit('page', { url: `${p.label} (${model}) đang viết code cho "${f.name}"…` });
    let lastKb = 0;
    const raw = await CALLS[provider]({
      key, model, text, image, signal,
      onDelta: len => {
        const kb = Math.floor(len / 10240) * 10;
        if (kb > lastKb) { lastKb = kb; emit('page', { url: `${p.label}: đã nhận ${kb} KB` }); }
      },
    });
    const r = parseResult(raw);

    await save(`${base}.css`, r.css);
    if (r.js.trim()) await save(`${base}.js`, r.js);
    await save(file, `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(f.name)}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fontLinks(fonts)}
<link rel="stylesheet" href="${base}.css">
</head>
<body>
${r.html}
${r.js.trim() ? `<script src="${base}.js"></script>\n` : ''}</body>
</html>
`);
    stats.pages++;
    emit('page', { url: `Đã tạo ${file}` });
  }
  return { ...stats, out: OUT, entry: 'index.html', aborted: false };
}
