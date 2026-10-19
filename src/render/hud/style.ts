/** HUD stylesheet, injected once by `injectHudStyle` (docs/DESIGN.md §11). */
export const HUD_CSS = `
.hud{position:absolute;inset:0;pointer-events:none;font:600 16px/1.2 system-ui,sans-serif;color:#fff;text-shadow:0 1px 3px #000}
.hud [hidden]{display:none}
.hud-status{position:absolute;top:12px;left:16px}
.hud-status .phase{text-transform:capitalize;opacity:.8}
.hud-feed{position:absolute;top:12px;right:16px;text-align:right;display:flex;flex-direction:column;gap:4px}
.hud-feed .kill{background:rgba(0,0,0,.45);padding:2px 8px;border-radius:3px}
.hud-feed .kill.mine{color:#ffd24a}
.hud-feed .kill.against{color:#ff6b5c}
.hud-announcer{position:absolute;top:14%;left:0;right:0;text-align:center;font-size:36px;letter-spacing:.04em;text-transform:uppercase}
.hud-vitals{position:absolute;bottom:16px;left:16px;width:200px}
.hud-vitals .row{display:flex;align-items:center;gap:8px;margin-top:6px}
.hud-vitals .num{font-size:30px;min-width:56px}
.hud-vitals .bar{flex:1;height:8px;background:rgba(0,0,0,.5);border-radius:4px;overflow:hidden}
.hud-vitals .fill{height:100%}
.hud-health .fill{background:#52d65c}
.hud-health.low .fill{background:#ff4a3d}
.hud-health.low .num{color:#ff4a3d}
.hud-shield .fill{background:#4aa8ff}
.hud-ammo{position:absolute;bottom:16px;right:16px;text-align:right}
.hud-ammo .num{font-size:30px}
.hud-ammo .name{opacity:.8;font-size:13px}
.hud-bar{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:4px}
.hud-slot{width:54px;padding:3px 0;text-align:center;background:rgba(0,0,0,.4);border:1px solid transparent;border-radius:3px;font-size:12px;opacity:.35}
.hud-slot.owned{opacity:.85}
.hud-slot.selected{opacity:1;border-color:#ffd24a;background:rgba(80,60,0,.6)}
.hud-slot .key{font-size:15px}
.hud-cross{position:absolute;left:50%;top:50%;width:0;height:0}
.hud-cross i{position:absolute;display:block;background:#fff;box-shadow:0 0 2px #000}
.hud-cross.dot i{left:-2px;top:-2px;width:4px;height:4px;border-radius:2px}
.hud-cross.cross i{left:-1px;top:-9px;width:2px;height:18px}
.hud-cross.cross::before{content:"";position:absolute;left:-9px;top:-1px;width:18px;height:2px;background:#fff;box-shadow:0 0 2px #000}
.hud-cross.ring i{left:-9px;top:-9px;width:14px;height:14px;background:none;border:2px solid #fff;border-radius:50%}
.hud-cross.bracket i{left:-12px;top:-8px;width:20px;height:12px;background:none;border:2px solid #fff;border-top:0;border-radius:0 0 4px 4px}
.hud-cross.scope i{left:-1px;top:-300px;width:2px;height:600px}
.hud-cross.scope::before{content:"";position:absolute;left:-300px;top:-1px;width:600px;height:2px;background:#fff}
.hud-cross.none{display:none}
.hud-zoom{position:absolute;left:50%;top:calc(50% + 40px);transform:translateX(-50%);font-size:20px}
.hud-dead{position:absolute;top:55%;left:0;right:0;text-align:center;font-size:24px}
.hud-power{position:absolute;bottom:90px;left:16px;font-size:13px;color:#ffd24a}
`;

const STYLE_ID = 'ut-hud-style';

export function injectHudStyle(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = HUD_CSS;
  doc.head.appendChild(el);
}
