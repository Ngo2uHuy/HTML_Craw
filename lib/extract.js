// Trích URL ảnh/icon từ HTML và CSS bằng regex (không cần parser ngoài).
const IMG_EXT = 'png|jpe?g|gif|webp|avif|svg|ico|bmp|jfif|heic';
const IMG_EXT_RE = new RegExp(`\\.(${IMG_EXT})(\\?|#|$)`, 'i');
const NON_IMG_EXT_RE = /\.(woff2?|ttf|otf|eot|css|js|mjs|json|mp4|webm|mp3|pdf|zip)(\?|#|$)/i;

const URL_ATTRS = ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-bg', 'data-background',
  'data-background-image', 'data-image', 'data-img', 'data-full', 'data-full-url', 'data-large_image', 'data-zoom-image',
  'data-hi-res', 'data-retina', 'poster', 'xlink:href'];
const SRC_TAGS = new Set(['img', 'source', 'input', 'image', 'amp-img', 'picture']);
const SRCSET_ATTRS =['srcset', 'data-srcset', 'data-lazy-srcset'];
const META_IMG = /^(og:image(:url|:secure_url)?|twitter:image(:src)?|msapplication-tileimage|msapplication-square\d+x\d+logo|msapplication-wide\d+x\d+logo|image|thumbnail)$/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

// Theo thuật toán của HTML spec: URL có thể chứa dấu phẩy (vd: Cloudinary), chỉ phẩy cuối URL mới là phân cách
export function parseSrcset(v) {
  const out = [];
  let i = 0;
  while (i < v.length) {
    while (i < v.length && /[\s,]/.test(v[i])) i++;
    let j = i;
    while (j < v.length && !/\s/.test(v[j])) j++;
    let url = v.slice(i, j);
    i = j;
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      while (i < v.length && v[i] !== ',') i++;
    }
    if (url) out.push(url);
  }
  return out;
}

export function cssUrls(css) {
  const out = [];
  const re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
  let m;
  while ((m = re.exec(css))) out.push(m[2].trim());
  const imp = /@import\s+(['"])(.*?)\1/gi;
  while ((m = imp.exec(css))) out.push(m[2].trim());
  const set = /image-set\(([^)]*)\)/gi;
  while ((m = set.exec(css))) for (const s of m[1].matchAll(/(['"])(.*?)\1/g)) out.push(s[2]);
  return out;
}

export function isLikelyImageUrl(u) {
  return u.startsWith('data:image/') || IMG_EXT_RE.test(u);
}
export function isNonImageUrl(u) {
  return NON_IMG_EXT_RE.test(u);
}

// Bóc <symbol> trong sprite inline thành SVG độc lập; svg thường giữ nguyên.
function inlineSvgs(html) {
  const out = [];
  for (const m of html.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)) {
    const svg = m[0];
    const symbols = [...svg.matchAll(/<symbol\b([^>]*)>([\s\S]*?)<\/symbol>/gi)];
    if (symbols.length) {
      for (const s of symbols) {
        const a = parseAttrs(s[1]);
        const vb = a.viewbox ? ` viewBox="${a.viewbox}"` : '';
        out.push({ name: a.id, svg: `<svg xmlns="http://www.w3.org/2000/svg"${vb}>${s[2]}</svg>` });
      }
      continue;
    }
    // Chỉ chứa <use href="#..."> thì đứng riêng không hiển thị gì → bỏ
    if (/<use\b/i.test(svg) && !/<(path|circle|rect|polygon|polyline|ellipse|line|image|text|g)\b/i.test(svg.replace(/<use\b[^>]*>/gi, ''))) continue;
    const fixed = /xmlns=/.test(svg.slice(0, 300)) ? svg : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    out.push({ name: (svg.match(/\b(?:id|aria-label|class)="([^"]{1,40})"/) || [])[1], svg: fixed });
  }
  return out;
}

/**
 * Trả về:
 *  images: [{ url, source, iconHint, group? }]  (url thô, chưa resolve)
 *  stylesheets, manifests, links (thô), svgs: [{name, svg}], base
 */
export function extractFromHtml(html) {
  const images = [], stylesheets = [], manifests = [], links = [];
  let base = null, groupSeq = 0;
  const add = (url, source, iconHint = false, group) => { if (url) images.push({ url: url.trim(), source, iconHint, group }); };

  const body = html.replace(/<!--[\s\S]*?-->/g, '');
  const tagRe = /<([a-z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let m;
  while ((m = tagRe.exec(body))) {
    const tag = m[1].toLowerCase();
    const a = parseAttrs(m[2]);
    if (tag === 'base' && a.href) base = a.href;

    if (tag === 'link') {
      const rel = (a.rel || '').toLowerCase();
      if (/icon|apple-touch|mask-icon/.test(rel)) add(a.href, `link[rel=${rel}]`, true);
      else if (rel.includes('manifest')) manifests.push(a.href);
      else if (rel.includes('stylesheet') || (rel.includes('preload') && a.as === 'style')) stylesheets.push(a.href);
      else if (rel.includes('preload') && a.as === 'image') {
        const g = `g${groupSeq++}`;
        add(a.href, 'link[preload]', false, g);
        for (const u of parseSrcset(a.imagesrcset || '')) add(u, 'link[preload] srcset', false, g);
      } else if (rel === 'image_src') add(a.href, 'link[image_src]');
      continue;
    }
    if (tag === 'meta') {
      const name = a.property || a.name || a.itemprop || '';
      if (META_IMG.test(name) && a.content) add(a.content, `meta[${name}]`, /msapplication/i.test(name));
      continue;
    }
    if (tag === 'a' && a.href) {
      if (isLikelyImageUrl(a.href)) add(a.href, 'a[href]');
      else links.push(a.href);
    }

    const g = `g${groupSeq++}`;
    for (const k of URL_ATTRS) {
      // src của script/iframe/audio... không phải ảnh
      if (!a[k] || (k === 'src' && !SRC_TAGS.has(tag)) || (k === 'poster' && tag !== 'video')) continue;
      add(a[k], `${tag}[${k}]`, false, g);
    }
    if (tag === 'image' && a.href) add(a.href, 'svg image', false, g);
    for (const k of SRCSET_ATTRS) if (a[k]) for (const u of parseSrcset(a[k])) add(u, `${tag}[${k}]`, false, g);
    if (a.style) for (const u of cssUrls(a.style)) add(u, `${tag}[style]`);
  }

  for (const s of body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    for (const u of cssUrls(s[1])) {
      if (/\.css(\?|$)/i.test(u)) stylesheets.push(u);
      else add(u, 'style');
    }
  }

  // Quét toàn văn bản (script, JSON SSR như __NEXT_DATA__...) cho URL có đuôi ảnh
  const text = body.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/');
  const urlRe = new RegExp(`(?:https?:)?\\/\\/[^\\s"'<>()\\\\]+?\\.(?:${IMG_EXT})(?:\\?[^\\s"'<>()\\\\]*)?(?=[\\s"'<>()\\\\,]|$)`, 'gi');
  for (const u of text.match(urlRe) || []) add(u, 'text');
  const relRe = new RegExp(`(?<=["'(=,\\s])\\/(?!\\/)[^\\s"'<>()\\\\]+?\\.(?:${IMG_EXT})(?:\\?[^\\s"'<>()\\\\]*)?(?=[\\s"'<>()\\\\,]|$)`, 'gi');
  for (const u of text.match(relRe) || []) add(u, 'text');

  return { images, stylesheets, manifests, links, svgs: inlineSvgs(body), base };
}
