// Nhận diện các biến thể kích thước của cùng một ảnh (WordPress, Shopify/Haravan,
// Next.js image, CDN resize qua query...) để gom nhóm và suy ra URL ảnh gốc.
const SIZE_PARAMS = ['w', 'h', 'width', 'height', 'resize', 'fit', 'quality', 'q', 'size', 'dpr', 'crop', 'zoom', 'strip', 'fm', 'auto'];

const PATH_RULES = [
  /-\d{2,5}x\d{2,5}(\.[a-z0-9]+)$/i,  // WordPress: anh-300x200.jpg
  /-scaled(\.[a-z0-9]+)$/i,            // WordPress: anh-scaled.jpg
  /_(?:\d+x\d*|x\d+|pico|icon|thumb|small|compact|medium|large|grande|original|master)(?:_crop_\w+)?(?:@\dx)?(\.[a-z0-9]+)$/i, // Shopify/Haravan
  /@[1-4]x(\.[a-z0-9]+)$/i,           // retina: logo@2x.png
];

export function variantInfo(href) {
  let u;
  try { u = new URL(href); } catch { return { key: href, original: null }; }
  if (!/^https?:$/.test(u.protocol)) return { key: href, original: null };

  if (/\/_next\/image\/?$/.test(u.pathname) && u.searchParams.get('url')) {
    try {
      const inner = new URL(u.searchParams.get('url'), u).href;
      return { key: variantInfo(inner).key, original: inner };
    } catch { /* url lỗi → xử lý như ảnh thường */ }
  }

  let path = u.pathname;
  for (const re of PATH_RULES) path = path.replace(re, '$1');
  const q = new URLSearchParams(u.search);
  for (const p of SIZE_PARAMS) q.delete(p);
  const qs = q.toString();
  const key = u.origin + path + (qs ? '?' + qs : '');
  return { key, original: key !== href ? key : null };
}
