// Canvas renderer. Draws whatever the character pack describes.
//
// Two inputs:
//   state — from pet-core: sprite, gaze, energy. The continuous fast-loop layer.
//   anim  — from ActionPlayer.sample(): look, transform, frame. The one-shot layer.
//
// Procedural packs are drawn from `look` (shape/ears/eyes/palette) so switching
// characters needs no image assets. Sprite packs draw `frame` instead, with the
// action transform still applied on top.

// Wraps to a pixel width, breaking on spaces where the text has them and falling back to
// per-character breaks where it does not.
//
// It used to break per character unconditionally, which is right for Chinese and wrong for
// English: "anyway" came out as "any / way". Since the pet now speaks and hears English, and
// a caption is read at a glance, mid-word breaks are worth avoiding. A single token longer
// than the line still gets split rather than overflowing, and CJK — which has no spaces —
// falls through to the old behaviour, which was correct for it all along.
export function wrapText(ctx, text, maxW) {
  const out = [];
  const fits = (s) => ctx.measureText(s).width <= maxW;
  // Keep the spaces attached to the preceding token so widths stay accurate.
  const tokens = String(text).match(/\S+\s*|\s+/g) ?? [];
  let cur = '';
  for (const tok of tokens) {
    if (fits(cur + tok) || !cur) {
      if (fits(cur + tok)) { cur += tok; continue; }
      // A single token wider than the line: split it by character.
      let piece = '';
      for (const ch of tok) {
        if (fits(piece + ch) || !piece) piece += ch;
        else { out.push(piece); piece = ch; }
      }
      cur = piece;
      continue;
    }
    out.push(cur.trimEnd());
    cur = tok.trimStart();
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out.length ? out : [''];
}

const FALLBACK = { body: '#8ec5b6', cheek: '#e8b4a0' };

export class PetRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.blinkPhase = 0;
    this.bob = 0;
    this.shownLine = null;
    this.lineUntil = 0;
    // What the *user* said, drawn under the character like a subtitle. Separate from
    // shownLine because the two are different speakers and must never be confused: the
    // pet's line is above it in a bubble, this is below it as a caption.
    this.caption = null;
    this.captionUntil = 0;
    this.captionFinal = false;
    this.images = new Map();
    this.lastFrameMiss = null;
    // Sheet packs are big: a Desktop_Gremlin pack is 325x325 cells up to 140 frames,
    // so one sheet is ~25 MB decoded and the whole pack is over 400 MB. An always-on
    // desktop pet cannot hold that, so the cache is a small LRU — the current state's
    // sheet stays hot and one-shot action sheets get dropped again.
    this.maxSheets = 4;
    // Normalised screen position, driven by the locomotion controller. Null = the
    // classic centered layout.
    this.pos = null;
  }

  setPos(pos) {
    this.pos = pos ? { x: pos.x, y: pos.y } : null;
  }

  setLine(text, now, holdMs = 3200) {
    if (!text) return;
    this.shownLine = text;
    this.lineUntil = now + holdMs;
  }

  // Live subtitle of what the user is saying.
  //
  // Partials arrive every few tens of milliseconds and get rewritten constantly, so they are
  // shown as they come — that responsiveness is the point of using partials at all — but held
  // only briefly, because a half-recognised fragment left on screen after someone stops
  // talking reads as a bug. A final is the authoritative text and stays long enough to read.
  setCaption(text, now, { final = false, holdMs = null } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return;
    this.caption = clean;
    this.captionFinal = final;
    this.captionUntil = now + (holdMs ?? (final ? 4000 : 1400));
  }

  clearCaption() {
    this.caption = null;
    this.captionUntil = 0;
    this.captionFinal = false;
  }

  // Sheets load lazily and draw only once decoded; a missing or still-loading sheet
  // degrades to the procedural body rather than to an empty window.
  image(src) {
    if (!src) return null;
    let img = this.images.get(src);
    if (img) {
      // Re-insert to mark as most recently used.
      this.images.delete(src);
      this.images.set(src, img);
    } else {
      img = new Image();
      img.addEventListener('error', () => { this.lastFrameMiss = src; });
      img.src = src;
      this.images.set(src, img);
      while (this.images.size > this.maxSheets) {
        const [oldest, oldImg] = this.images.entries().next().value;
        this.images.delete(oldest);
        // Dropping src releases the decoded bitmap; without this the browser keeps it
        // alive as long as the element exists and the LRU buys nothing.
        oldImg.src = '';
      }
    }
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  draw(state, now, anim = null) {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 320;
    const cssH = canvas.clientHeight || 320;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const sprite = state?.sprite ?? 'away';
    const look = anim?.look ?? {};
    const palette = look.palette ?? {};
    const c = palette[sprite] ?? palette.idle ?? FALLBACK;
    const shape = look.shape ?? 'blob';
    const ears = look.ears ?? 'round';
    const eyeStyle = look.eyes ?? 'dot';
    const outline = look.outline ?? null;
    const asleep = sprite === 'sleepy';
    const away = sprite === 'away';
    const ghost = shape === 'ghost';

    this.bob += asleep ? 0.012 : 0.03;
    const bobY = Math.sin(this.bob) * (asleep ? 2.5 : 4);

    // Capped: the canvas now spans the whole page so the character can walk anywhere,
    // and without the cap her size would scale with the viewport instead of staying the
    // 300px-box size the sprites were tuned for.
    const r = Math.min(72, Math.min(cssW, cssH) * 0.24) * (anim?.scale ?? 1);
    const px = cssW * (this.pos?.x ?? 0.5);
    const py = cssH * (this.pos?.y ?? 0.56);
    const t = anim?.transform ?? { dx: 0, dy: 0, rot: 0, squash: 1 };
    const gx = state?.gaze?.x ?? 0;
    const gy = state?.gaze?.y ?? 0;

    const cx = px + gx * r * 0.12 + t.dx * r;
    const cy = py + bobY + t.dy * r;

    const alpha = away ? 0.35 : ghost ? 0.9 : 1;
    ctx.globalAlpha = alpha;

    // Shadow stays in screen space so it does not rotate or hop with the body — it
    // shrinks instead, which is what sells a jump.
    const lift = Math.max(0, -t.dy);
    ctx.beginPath();
    ctx.ellipse(px + gx * r * 0.12, py + r * 1.15,
      r * (0.85 - lift * 0.25), r * (0.2 - lift * 0.06), 0, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0,0,0,${0.13 * (1 - lift * 0.5)})`;
    ctx.fill();

    ctx.save();
    ctx.translate(cx, cy);
    if (t.rot) ctx.rotate(t.rot);

    // Sheet packs: blit one cell out of a row-major grid. Falls through to the
    // procedural body while the sheet is still decoding or if it failed to load.
    const sp = anim?.sprite;
    const sheetImg = sp ? this.image(sp.sheet) : null;
    if (sp && sheetImg) {
      const h = r * 2.4;
      const w = h * (sp.cell.w / sp.cell.h);
      ctx.drawImage(sheetImg, sp.sx, sp.sy, sp.cell.w, sp.cell.h, -w / 2, -h / 2, w, h);
      ctx.restore();
      ctx.globalAlpha = 1;
      this.drawSpeech(state, now, cssW, cssH, cy - r * 1.35);
      this.drawCaption(now, cssW, cssH, py + r * 1.3);
      return;
    }

    const stateSquash = sprite === 'curious' ? 1.06 : asleep ? 0.94 : 1;
    const squash = stateSquash * (t.squash ?? 1);

    // Ears go behind the body.
    if (ears !== 'none') {
      const earLift = sprite === 'curious' ? -r * 0.25 : sprite === 'annoyed' ? r * 0.1 : 0;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        if (ears === 'pointy') {
          ctx.moveTo(s * r * 0.34, -r * 0.72 + earLift);
          ctx.lineTo(s * r * 0.78, -r * 1.24 + earLift);
          ctx.lineTo(s * r * 0.86, -r * 0.6 + earLift);
          ctx.closePath();
        } else {
          ctx.ellipse(s * r * 0.62, -r * 0.72 + earLift, r * 0.2, r * 0.3, s * 0.3, 0, Math.PI * 2);
        }
        ctx.fillStyle = c.body;
        ctx.fill();
        if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = Math.max(1, r * 0.03); ctx.stroke(); }
      }
    }

    ctx.save();
    ctx.scale(1 / squash, squash);
    ctx.beginPath();
    if (shape === 'cat') {
      ctx.moveTo(0, -r * 0.95);
      ctx.bezierCurveTo(r * 1.0, -r * 0.9, r * 1.0, r * 0.7, r * 0.5, r * 0.98);
      ctx.bezierCurveTo(r * 0.2, r * 1.12, -r * 0.2, r * 1.12, -r * 0.5, r * 0.98);
      ctx.bezierCurveTo(-r * 1.0, r * 0.7, -r * 1.0, -r * 0.9, 0, -r * 0.95);
    } else if (shape === 'ghost') {
      // Wavy hem, phase-shifted by the bob so it ripples while floating.
      ctx.moveTo(-r * 0.9, r * 0.35);
      ctx.bezierCurveTo(-r * 0.95, -r * 1.05, r * 0.95, -r * 1.05, r * 0.9, r * 0.35);
      const n = 4;
      for (let i = 0; i < n; i += 1) {
        const x0 = r * 0.9 - (i * 2 * r * 0.9) / n;
        const x1 = r * 0.9 - ((i + 1) * 2 * r * 0.9) / n;
        const dip = r * 0.22 * (i % 2 === 0 ? 1 : -1) * (1 + Math.sin(this.bob) * 0.2);
        ctx.quadraticCurveTo((x0 + x1) / 2, r * 0.35 + dip, x1, r * 0.35);
      }
    } else {
      ctx.moveTo(0, -r);
      ctx.bezierCurveTo(r * 1.15, -r * 0.9, r * 1.05, r * 0.95, 0, r);
      ctx.bezierCurveTo(-r * 1.05, r * 0.95, -r * 1.15, -r * 0.9, 0, -r);
    }
    ctx.closePath();
    ctx.fillStyle = c.body;
    ctx.fill();
    if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = Math.max(1, r * 0.035); ctx.stroke(); }
    ctx.restore();

    // Face. Drawn unsquashed so expressions stay readable during stretch/jump.
    const big = eyeStyle === 'big';
    const eyeY = -r * 0.12 + gy * r * 0.12;
    const eyeDx = r * (big ? 0.36 : 0.34);
    const eyeR = r * (big ? 0.2 : 0.15);
    const pupilR = r * (big ? 0.095 : 0.075);
    const pupilDx = gx * r * 0.09;
    this.blinkPhase += 0.02;
    const autoBlink = Math.sin(this.blinkPhase * 3.1) > 0.985;
    const closed = asleep || away || autoBlink;

    for (const s of [-1, 1]) {
      const ex = s * eyeDx;
      if (closed) {
        ctx.beginPath();
        ctx.moveTo(ex - eyeR * 0.95, eyeY);
        ctx.quadraticCurveTo(ex, eyeY + r * 0.07, ex + eyeR * 0.95, eyeY);
        ctx.strokeStyle = '#3a3a3a';
        ctx.lineWidth = Math.max(2, r * 0.045);
        ctx.lineCap = 'round';
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(ex, eyeY, eyeR, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = Math.max(1, r * 0.02); ctx.stroke(); }
        ctx.beginPath();
        ctx.arc(ex + pupilDx, eyeY + gy * r * 0.05, pupilR, 0, Math.PI * 2);
        ctx.fillStyle = '#2f2f2f';
        ctx.fill();
        if (big) {
          ctx.beginPath();
          ctx.arc(ex + pupilDx - pupilR * 0.35, eyeY - pupilR * 0.4, pupilR * 0.32, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.fill();
        }
      }
      // Brows carry most of the expression.
      if (sprite === 'annoyed' || sprite === 'curious') {
        const browY = eyeY - r * (big ? 0.36 : 0.3);
        const tilt = sprite === 'annoyed' ? s * 0.45 : -s * 0.3;
        ctx.beginPath();
        ctx.moveTo(ex - r * 0.15, browY + tilt * r * 0.2);
        ctx.lineTo(ex + r * 0.15, browY - tilt * r * 0.2);
        ctx.strokeStyle = '#4a4a4a';
        ctx.lineWidth = Math.max(2, r * 0.04);
        ctx.lineCap = 'round';
        ctx.stroke();
      }
    }

    if (sprite === 'happy' || sprite === 'curious') {
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(s * r * 0.55, eyeY + r * 0.22, r * 0.1, 0, Math.PI * 2);
        ctx.fillStyle = c.cheek;
        ctx.globalAlpha = alpha * 0.65;
        ctx.fill();
        ctx.globalAlpha = alpha;
      }
    }

    if (shape === 'cat') {
      ctx.strokeStyle = 'rgba(70,55,50,0.45)';
      ctx.lineWidth = Math.max(1, r * 0.022);
      for (const s of [-1, 1]) {
        for (const k of [-1, 0, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * r * 0.42, eyeY + r * 0.34 + k * r * 0.06);
          ctx.lineTo(s * r * 0.86, eyeY + r * 0.3 + k * r * 0.13);
          ctx.stroke();
        }
      }
    }

    const mouthY = eyeY + r * 0.42;
    ctx.beginPath();
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth = Math.max(2, r * 0.045);
    ctx.lineCap = 'round';
    if (sprite === 'happy') {
      ctx.arc(0, mouthY - r * 0.06, r * 0.16, 0.15 * Math.PI, 0.85 * Math.PI);
    } else if (sprite === 'annoyed') {
      ctx.arc(0, mouthY + r * 0.16, r * 0.16, 1.15 * Math.PI, 1.85 * Math.PI);
    } else if (asleep) {
      ctx.moveTo(-r * 0.06, mouthY);
      ctx.lineTo(r * 0.06, mouthY);
    } else if (sprite === 'curious') {
      ctx.arc(0, mouthY, r * 0.07, 0, Math.PI * 2);
    } else {
      ctx.moveTo(-r * 0.08, mouthY);
      ctx.quadraticCurveTo(0, mouthY + r * 0.05, r * 0.08, mouthY);
    }
    ctx.stroke();

    if (asleep) {
      ctx.fillStyle = 'rgba(90,90,120,0.75)';
      ctx.font = `${Math.round(r * 0.3)}px system-ui, sans-serif`;
      const zt = Math.sin(this.bob * 0.7);
      ctx.fillText('z', r * 0.75, -r * 0.8 + zt * 4);
      ctx.font = `${Math.round(r * 0.22)}px system-ui, sans-serif`;
      ctx.fillText('z', r * 1.0, -r * 1.05 - zt * 3);
    }

    ctx.restore();
    ctx.globalAlpha = 1;
    this.drawSpeech(state, now, cssW, cssH, cy - r * 1.35);
    // Anchored to the shadow's row rather than to the bobbing body, so the subtitle does not
    // bounce along with the character while it breathes.
    this.drawCaption(now, cssW, cssH, py + r * 1.3);
  }

  // Subtitle styling follows video captions rather than the pet's speech bubble: dark plate,
  // light text, bottom-anchored. A viewer should be able to tell at a glance which of the two
  // is the pet talking and which is themselves.
  drawCaption(now, cssW, cssH, y) {
    if (!this.caption) return;
    if (now >= this.captionUntil) { this.clearCaption(); return; }
    const { ctx } = this;
    // A still-forming partial is drawn faintly so it reads as provisional; a final is solid.
    const remain = this.captionUntil - now;
    const fade = Math.min(1, remain / 400);
    ctx.globalAlpha = (this.captionFinal ? 1 : 0.72) * fade;

    const label = 'User: ';
    ctx.font = '13px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    const padX = 10;
    const padY = 6;
    const lineH = 18;
    const maxW = cssW - 24;
    // The text is wrapped on its own and the speaker label is re-attached to whatever line
    // ends up first, so a long utterance still says who is talking. Wrapping the label in
    // with the text meant "User:" scrolled off the top of a long sentence, which is exactly
    // the identification the caption exists to provide.
    const lines = wrapText(ctx, this.caption, maxW - padX * 2 - ctx.measureText(label).width);
    // Clipped from the front: in a live caption the most recent words are the ones being said.
    const shown = lines.slice(-2);
    shown[0] = label + shown[0];
    const w = Math.min(maxW, Math.max(...shown.map((l) => ctx.measureText(l).width)) + padX * 2);
    const h = shown.length * lineH + padY * 2;
    const x = (cssW - w) / 2;
    const top = Math.min(cssH - h - 4, y);
    const rr = 8;
    ctx.beginPath();
    ctx.moveTo(x + rr, top);
    ctx.arcTo(x + w, top, x + w, top + h, rr);
    ctx.arcTo(x + w, top + h, x, top + h, rr);
    ctx.arcTo(x, top + h, x, top, rr);
    ctx.arcTo(x, top, x + w, top, rr);
    ctx.closePath();
    ctx.fillStyle = 'rgba(18,18,20,0.78)';
    ctx.fill();

    shown.forEach((l, i) => {
      const ty = top + padY + lineH * i + lineH / 2;
      // The "User:" prefix is dimmed so the words themselves lead.
      if (i === 0 && l.startsWith(label)) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(label, x + padX, ty);
        ctx.fillStyle = '#fff';
        ctx.fillText(l.slice(label.length), x + padX + ctx.measureText(label).width, ty);
      } else {
        ctx.fillStyle = '#fff';
        ctx.fillText(l, x + padX, ty);
      }
    });
    ctx.globalAlpha = 1;
  }

  drawSpeech(state, now, cssW, cssH, y) {
    if (this.shownLine && now < this.lineUntil) {
      this.drawBubble(this.shownLine, cssW, cssH, y);
    } else if (now >= this.lineUntil) {
      this.shownLine = null;
    }
  }

  // Wraps, because a model-written line is not length-controlled the way the mock
  // script's canned lines were.
  drawBubble(text, cssW, cssH, y) {
    const { ctx } = this;
    ctx.font = '15px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'middle';
    const padX = 12;
    const padY = 9;
    const maxW = cssW - 32;
    const lines = wrapText(ctx, text, maxW - padX * 2);
    const lineH = 20;
    const w = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2);
    const h = lines.length * lineH + padY * 2;
    const x = (cssW - w) / 2;
    const top = Math.max(6, y - h);
    const rr = 10;
    ctx.beginPath();
    ctx.moveTo(x + rr, top);
    ctx.arcTo(x + w, top, x + w, top + h, rr);
    ctx.arcTo(x + w, top + h, x, top + h, rr);
    ctx.arcTo(x, top + h, x, top, rr);
    ctx.arcTo(x, top, x + w, top, rr);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cssW / 2 - 6, top + h);
    ctx.lineTo(cssW / 2, top + h + 8);
    ctx.lineTo(cssW / 2 + 6, top + h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.fill();
    ctx.fillStyle = '#222';
    lines.forEach((l, i) => ctx.fillText(l, x + padX, top + padY + lineH * i + lineH / 2));
  }
}
