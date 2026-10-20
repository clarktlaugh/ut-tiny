/** Menu stylesheet, injected once by `injectMenuStyle` (docs/DESIGN.md §11). */
export const MENU_CSS = `
.menu{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(10,12,20,.82);color:#fff;font:500 16px/1.3 system-ui,sans-serif;overflow:auto;padding:16px;box-sizing:border-box}
.menu [hidden]{display:none}
.menu-panel{width:min(480px,100%);max-height:100%;overflow:auto;background:#1b2030;border:1px solid #3a4260;border-radius:8px;padding:20px;display:flex;flex-direction:column;gap:12px}
.menu-panel.wide{width:min(720px,100%)}
.menu h1{margin:0;font-size:32px;letter-spacing:.04em;text-transform:uppercase}
.menu h2{margin:0;font-size:22px}
.menu .sub{opacity:.7;font-size:14px}
.menu button{min-height:44px;padding:8px 16px;font:inherit;font-weight:700;color:#fff;background:#2f6fe0;border:0;border-radius:6px;cursor:pointer}
.menu button.secondary{background:#3a4260}
.menu button:disabled{opacity:.4}
.menu .field{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px}
.menu .field .label{flex:0 0 38%}
.menu .field .control{flex:1;display:flex;align-items:center;gap:8px}
.menu .field input[type=range]{flex:1;min-width:0}
.menu .field select{flex:1;min-height:36px;font:inherit}
.menu .field .readout{min-width:64px;text-align:right}
.menu .actions{display:flex;gap:8px}
.menu .actions button{flex:1}
.menu table{width:100%;border-collapse:collapse;font-size:15px}
.menu th,.menu td{padding:6px 8px;text-align:right}
.menu th:nth-child(2),.menu td:nth-child(2){text-align:left}
.menu tr.winner td{color:#ffd24a;font-weight:700}
.menu tr.local td{background:rgba(255,255,255,.08)}
`;

const STYLE_ID = 'ut-menu-style';

export function injectMenuStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = MENU_CSS;
  doc.head.appendChild(el);
}
