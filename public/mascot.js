// ドット絵の剣士（マスコット）。四角い体・4本足・左右の小さな腕・フルーレ。
// 座標は 1 = 1ドット。体の中心は x=15.5。右向きに描き、ブルーは CSS で左右反転する。
// 表情は data-face（normal / blink / angry / hurt / happy / sad）で切り替える。

export const MASCOT_VIEW = { x: -1, y: -3, w: 54, h: 26, bodyCenter: 15.5 };

const FACES = `
  <g class="face face-normal">
    <rect x="8" y="5" width="2" height="5"/><rect x="21" y="5" width="2" height="5"/>
  </g>
  <g class="face face-blink">
    <rect x="7.5" y="8" width="3" height="1"/><rect x="20.5" y="8" width="3" height="1"/>
  </g>
  <g class="face face-angry">
    <rect x="8" y="6.5" width="2" height="3.5"/><rect x="21" y="6.5" width="2" height="3.5"/>
    <path d="M6.5 4.2 L11.5 5.6 L11.5 6.6 L6.5 5.2Z M24.5 4.2 L19.5 5.6 L19.5 6.6 L24.5 5.2Z"/>
  </g>
  <g class="face face-hurt" fill="none" stroke-width="0.9" stroke-linecap="round">
    <path d="M7.3 5.6 L10.7 9 M10.7 5.6 L7.3 9 M20.3 5.6 L23.7 9 M23.7 5.6 L20.3 9"/>
  </g>
  <g class="face face-happy" fill="none" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 8.6 L9 6.4 L11 8.6 M20 8.6 L22 6.4 L24 8.6"/>
  </g>
  <g class="face face-sad">
    <rect x="8" y="7" width="2" height="3"/><rect x="21" y="7" width="2" height="3"/>
    <path d="M6.6 6 L11 5 L11 5.8 L6.6 6.8Z M24.4 6 L20 5 L20 5.8 L24.4 6.8Z"/>
  </g>`;

const BODY = `
  <g class="legs">
    <rect x="5" y="15.5" width="2" height="6.5"/><rect x="9" y="15.5" width="2" height="6.5"/>
    <rect x="20" y="15.5" width="2" height="6.5"/><rect x="24" y="15.5" width="2" height="6.5"/>
  </g>
  <g class="torso">
    <rect x="3" y="0" width="25" height="16"/>
    <rect x="0" y="7" width="3.4" height="4"/><rect x="27.6" y="7" width="3.4" height="4"/>
  </g>`;

// フルーレ: 握り・お椀形のつば・細い刃・先端
const FOIL = `
  <g class="foil">
    <rect class="grip" x="29.4" y="8.3" width="2.4" height="1.4" rx="0.3"/>
    <line class="blade" x1="32" y1="9" x2="50.5" y2="1.6"/>
    <ellipse class="guard" cx="32.1" cy="9" rx="0.9" ry="2.1" transform="rotate(-22 32.1 9)"/>
    <circle class="tip" cx="50.6" cy="1.55" r="0.65"/>
  </g>`;

export function mascotSvg({ className = '' } = {}) {
  const { x, y, w, h } = MASCOT_VIEW;
  return `<svg class="mascot-svg ${className}" viewBox="${x} ${y} ${w} ${h}" aria-hidden="true" shape-rendering="crispEdges">
    <g class="mascot-inner">${FOIL}${BODY}<g class="eyes">${FACES}</g></g></svg>`;
}

// 試合場に置く剣士。外側の div を left で動かし、中の .hop を跳ねさせる
export function createFencer(player) {
  const el = document.createElement('div');
  el.className = `fencer p${player}`;
  el.dataset.face = 'normal';
  el.innerHTML = `<div class="shadow"></div><div class="hop">${mascotSvg()}</div>`;
  startBlinking(el);
  return el;
}

// 試合場の外（ロビーなど）に飾る剣士
export function createFigure(player, face = 'normal') {
  const el = document.createElement('div');
  el.className = `figure p${player}`;
  el.dataset.face = face;
  el.innerHTML = mascotSvg();
  startBlinking(el);
  return el;
}

export function setFace(el, face) {
  el.dataset.face = face;
}

// ときどき瞬きする（普通の顔のときだけ）
function startBlinking(el) {
  const loop = () => {
    const wait = 1800 + Math.random() * 3200;
    setTimeout(() => {
      if (el.isConnected) el.wasConnected = true;
      else if (el.wasConnected) return; // 画面から外れたら止める
      if (el.isConnected && el.dataset.face === 'normal') {
        el.dataset.face = 'blink';
        setTimeout(() => {
          if (el.dataset.face === 'blink') el.dataset.face = 'normal';
        }, 130);
      }
      loop();
    }, wait);
  };
  loop();
}
