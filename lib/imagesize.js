// Đọc định dạng + kích thước ảnh từ bytes, không cần thư viện ngoài.
export function imageInfo(buf) {
  try {
    if (buf.length < 12) return null;
    if (buf.readUInt32BE(0) === 0x89504e47) {
      return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.toString('ascii', 0, 3) === 'GIF') {
      return { format: 'gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) return jpeg(buf);
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return webp(buf);
    if (buf.toString('ascii', 0, 2) === 'BM') {
      return { format: 'bmp', width: buf.readUInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1) return ico(buf);
    if (buf.toString('ascii', 4, 8) === 'ftyp') return avif(buf);
    const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
    if (/<svg[\s>]/i.test(head)) return svg(buf.toString('utf8'));
  } catch {
    // File bị cắt cụt / hỏng → coi như không phải ảnh
  }
  return null;
}

function jpeg(buf) {
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const m = buf[off + 1];
    if (m === 0xff) { off++; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { format: 'jpg', height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { off += 2; continue; }
    off += 2 + buf.readUInt16BE(off + 2);
  }
  return { format: 'jpg', width: 0, height: 0 };
}

function webp(buf) {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') {
    return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { format: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { format: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return { format: 'webp', width: 0, height: 0 };
}

function ico(buf) {
  const count = buf.readUInt16LE(4);
  if (!count || count > 256 || buf.length < 6 + count * 16) return null;
  let width = 0, height = 0;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = buf[o] || 256, h = buf[o + 1] || 256;
    if (w * h > width * height) { width = w; height = h; }
  }
  return { format: 'ico', width, height };
}

function avif(buf) {
  const brand = buf.toString('ascii', 8, 12);
  if (!/^(avif|avis|heic|heix|mif1)$/.test(brand)) return null;
  const i = buf.indexOf('ispe');
  const format = brand.startsWith('avi') ? 'avif' : 'heic';
  if (i < 0) return { format, width: 0, height: 0 };
  return { format, width: buf.readUInt32BE(i + 8), height: buf.readUInt32BE(i + 12) };
}

function svg(text) {
  const tag = (text.match(/<svg\b[^>]*>/i) || [''])[0];
  const attr = (name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, 'i'));
    return m ? m[1].trim() : '';
  };
  const num = (v) => (/^[\d.]+(px)?$/i.test(v) ? Math.round(parseFloat(v)) : 0);
  let width = num(attr('width')), height = num(attr('height'));
  const vb = attr('viewBox').split(/[\s,]+/).map(Number);
  if ((!width || !height) && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    if (width) height = Math.round((width * vb[3]) / vb[2]);
    else if (height) width = Math.round((height * vb[2]) / vb[3]);
    else { width = Math.round(vb[2]); height = Math.round(vb[3]); }
  }
  return { format: 'svg', width, height };
}
