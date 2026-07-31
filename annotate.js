// Draws what the fast loop detected onto the frame before it is sent to the model.
//
// The model gets a picture with the hand skeleton, the face box and the posture
// baseline already marked, instead of having to infer them. That grounds its reply in
// the same measurements the pet is reacting to — the numbers in the prompt and the
// marks in the image agree by construction.
//
// The geometry is separated from the drawing so the mapping is unit-tested with a
// recording stub in place of a real canvas context.

// MediaPipe's 21-point hand topology.
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],          // index
  [9, 10], [10, 11], [11, 12],             // middle
  [13, 14], [14, 15], [15, 16],            // ring
  [0, 17], [17, 18], [18, 19], [19, 20],   // pinky
  [5, 9], [9, 13], [13, 17],               // palm bridge
];

const TIPS = new Set([4, 8, 12, 16, 20]);

export const COLORS = {
  bone: 'rgba(0, 220, 255, 0.95)',
  joint: 'rgba(255, 255, 255, 0.95)',
  tip: 'rgba(255, 90, 90, 1)',
  face: 'rgba(120, 255, 140, 0.9)',
  baseline: 'rgba(255, 210, 80, 0.9)',
  label: 'rgba(0, 0, 0, 0.55)',
};

// Normalised landmarks -> pixels. Mirrored to match what the user sees, because the
// preview is mirrored and a model told "his left hand" should agree with the image.
export function toPixels(landmarks, w, h, mirror = true) {
  return landmarks.map((p) => ({
    x: (mirror ? 1 - p.x : p.x) * w,
    y: p.y * h,
  }));
}

export function faceBox(faceLandmarks, w, h, mirror = true) {
  if (!Array.isArray(faceLandmarks) || faceLandmarks.length === 0) return null;
  let minX = 1; let maxX = 0; let minY = 1; let maxY = 0;
  for (const p of faceLandmarks) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const x0 = (mirror ? 1 - maxX : minX) * w;
  const x1 = (mirror ? 1 - minX : maxX) * w;
  return { x: x0, y: minY * h, w: x1 - x0, h: (maxY - minY) * h };
}

function drawHand(ctx, pts, scale) {
  ctx.lineWidth = Math.max(1.5, 2.5 * scale);
  ctx.strokeStyle = COLORS.bone;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    if (!pts[a] || !pts[b]) continue;
    ctx.moveTo(pts[a].x, pts[a].y);
    ctx.lineTo(pts[b].x, pts[b].y);
  }
  ctx.stroke();
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, TIPS.has(i) ? 3.6 * scale : 2.4 * scale, 0, Math.PI * 2);
    ctx.fillStyle = TIPS.has(i) ? COLORS.tip : COLORS.joint;
    ctx.fill();
  });
}

function drawLabel(ctx, text, x, y, scale) {
  if (!text) return;
  const size = Math.max(9, 11 * scale);
  ctx.font = `${size}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  const pad = 3 * scale;
  const w = ctx.measureText(text).width + pad * 2;
  ctx.fillStyle = COLORS.label;
  ctx.fillRect(x, y, w, size + pad * 2);
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + pad, y + pad);
}

// `ctx` already holds the video frame. Returns a short description of what was marked,
// which the prompt states in words so image and text cannot disagree.
export function annotateFrame(ctx, {
  width, height, hands = [], faceLandmarks = null, faceConnections = null,
  baselineY = null, currentY = null, labels = [], mirror = true,
}) {
  const scale = Math.max(0.6, width / 640);
  const marked = [];

  // Face contours are drawn from the connection sets the tasks-vision bundle exports
  // (FACE_LANDMARKS_LIPS / LEFT_EYE / LEFT_EYEBROW / …), passed in by the caller rather
  // than hardcoded here — the 478-point indices are not something to reproduce by hand.
  if (Array.isArray(faceConnections) && faceConnections.length > 0 && Array.isArray(faceLandmarks) && faceLandmarks.length > 0) {
    const fp = toPixels(faceLandmarks, width, height, mirror);
    ctx.lineWidth = Math.max(1, 1.4 * scale);
    ctx.strokeStyle = COLORS.face;
    ctx.beginPath();
    for (const c of faceConnections) {
      const a = fp[c.start ?? c[0]];
      const b = fp[c.end ?? c[1]];
      if (!a || !b) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    marked.push('green mesh = brow / eye / mouth contours, which the expression reading comes from');
  }

  const box = faceBox(faceLandmarks, width, height, mirror);
  if (box) {
    ctx.lineWidth = Math.max(1.5, 2 * scale);
    ctx.strokeStyle = COLORS.face;
    ctx.setLineDash([6 * scale, 4 * scale]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);
    marked.push('green dashed box = the detected face');
  }

  // Two horizontal rules make the posture reading visible: where the head sat at
  // calibration, and where it is now.
  if (baselineY != null) {
    ctx.lineWidth = Math.max(1, 1.5 * scale);
    ctx.strokeStyle = COLORS.baseline;
    ctx.setLineDash([10 * scale, 6 * scale]);
    ctx.beginPath();
    ctx.moveTo(0, baselineY * height);
    ctx.lineTo(width, baselineY * height);
    ctx.stroke();
    ctx.setLineDash([]);
    marked.push('yellow dashed line = where their head sat at calibration');
  }
  if (currentY != null) {
    ctx.lineWidth = Math.max(1, 2 * scale);
    ctx.strokeStyle = COLORS.tip;
    ctx.beginPath();
    ctx.moveTo(0, currentY * height);
    ctx.lineTo(width, currentY * height);
    ctx.stroke();
    marked.push('red solid line = where their head is now');
  }

  let handCount = 0;
  for (const hand of hands) {
    if (!Array.isArray(hand) || hand.length < 21) continue;
    drawHand(ctx, toPixels(hand, width, height, mirror), scale);
    handCount += 1;
  }
  if (handCount > 0) marked.push(`cyan skeleton = hand landmarks (${handCount} hand${handCount > 1 ? 's' : ''}, red dots are fingertips)`);

  labels.forEach((text, i) => drawLabel(ctx, text, 6 * scale, 6 * scale + i * (16 * scale), scale));

  return marked;
}
