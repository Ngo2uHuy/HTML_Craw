// Chèn vào HTML bản clone khi cho người ngoài xem: chặn chuột phải, bôi đen, kéo ảnh, lưu/in/xem nguồn.
export const VIEW_GUARD = `<style>:not(input):not(textarea){-webkit-user-select:none!important;user-select:none!important}img,a{-webkit-user-drag:none}@media print{html{display:none!important}}</style>`
  + `<script>(()=>{for(const t of['contextmenu','selectstart','dragstart','copy','cut'])addEventListener(t,e=>e.preventDefault(),true);`
  + `addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(e.key==='F12'||((e.ctrlKey||e.metaKey)&&(['s','u','p','c'].includes(k)||(e.shiftKey&&['i','j','c'].includes(k)))))e.preventDefault()},true)})()</script>`;

const HEAD_RE = /<head[^>]*>/i;
export const injectGuard = html => (HEAD_RE.test(html) ? html.replace(HEAD_RE, h => h + VIEW_GUARD) : VIEW_GUARD + html);
