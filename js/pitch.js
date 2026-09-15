/**
 * Pitch - world-to-screen mapping, the camera, and the pitch furniture.
 *
 * Coordinates: x runs goal to goal (0..pitchW), y runs near touchline to far
 * touchline (0..pitchH). y = 0 is NEAR: it draws at the bottom of the screen,
 * at full size, in front of anything further up the pitch.
 *
 *   sx    = x * zoom                          (inside the world layer)
 *   sy    = pitchTop + (pitchH - y) * depthStep
 *   scale = 1 - (y / pitchH) * depthShrink
 *   z     = round(pitchH - y)
 *
 * The camera is not subtracted per entity. The world layer, the markings and
 * the crowd are each translated by -camX * zoom instead, which is one transform
 * per layer per frame rather than one subtraction per entity, and it gives the
 * crowd its parallax for free. Entity positions stay in world-layer space.
 *
 * Nothing here reads game state. The loop pushes the ball's x in and pulls
 * transforms out.
 */
const Pitch = (() => {
  let _viewport = null, _pitch = null, _markings = null, _world = null, _crowd = null, _fx = null;

  /** Recomputed on resize; every projection reads it. */
  const L = {
    viewW: 0, viewH: 0,
    zoom: 1, pitchTop: 0, pitchScreenH: 0, depthStep: 1,
    charScale: 1,   /* rig pixels -> screen pixels, before depth */
  };

  /* Camera and feel state. */
  let _camX = 0;          /* left edge of the visible window, world units */
  let _punch = 1;         /* current zoom-punch scale */
  let _punchTarget = 1;
  let _punchOx = 0.5, _punchOy = 0.5;   /* punch origin, fraction of the viewport */
  let _shake = 0;         /* remaining shake amplitude, px */

  /**
   * Bind the DOM layers. Call once.
   * @param {object} els - { viewport, pitch, markings, world, crowd, fx }
   */
  function init(els) {
    _viewport = els.viewport; _pitch = els.pitch; _markings = els.markings;
    _world = els.world; _crowd = els.crowd; _fx = els.fx;
    setScene(CONFIG.scene);
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
  }

  /**
   * Swap the pitch theme. Background, wall style and crowd strip are one CSS
   * class on the pitch container, so a new scene is a CSS block and a config
   * value rather than a code change.
   * @param {string} name - 'grass', and later 'moon', 'candy', …
   */
  function setScene(name) {
    if (!_pitch) return;
    _pitch.className = 'scene-' + name;
  }

  /** Recompute the layout and rebuild the markings at the new size. */
  function resize() {
    if (!_viewport) return;
    const r = _viewport.getBoundingClientRect();
    L.viewW = r.width;
    L.viewH = r.height;
    L.zoom = L.viewW / CONFIG.cameraViewW;

    /* Bands: crowd strip, headroom for far players, the pitch, a small skirt. */
    const crowdH = Math.round(L.viewH * 0.13);
    const topPad = Math.round(L.viewH * 0.11);
    const botPad = Math.round(L.viewH * 0.04);
    L.pitchTop = crowdH + topPad;
    L.pitchScreenH = Math.max(40, L.viewH - L.pitchTop - botPad);
    L.depthStep = L.pitchScreenH / CONFIG.pitchH;
    L.charScale = CONFIG.playerDrawH * L.zoom / Assets.CHAR_H;

    if (_crowd) _crowd.style.height = crowdH + 'px';
    _buildMarkings();
    _applyCamera();
  }

  /**
   * Project a world point.
   * @param {number} x - 0..pitchW
   * @param {number} y - 0..pitchH, 0 = near touchline
   * @returns {{sx: number, sy: number, scale: number, z: number}} sx/sy in
   *   world-layer pixels, scale is the depth factor alone (not the rig scale)
   */
  function project(x, y) {
    const depth = 1 - (y / CONFIG.pitchH) * CONFIG.depthShrink;
    return {
      sx: x * L.zoom,
      sy: L.pitchTop + (CONFIG.pitchH - y) * L.depthStep,
      scale: depth,
      z: Math.round(CONFIG.pitchH - y),
    };
  }

  /**
   * Convert a screen drag into world units. Used by touch input so a finger
   * travels the same world distance whatever the zoom.
   * @param {number} dxPx
   * @param {number} dyPx
   * @returns {{dx: number, dy: number}}
   */
  function screenToWorldDelta(dxPx, dyPx) {
    return { dx: dxPx / L.zoom, dy: -dyPx / L.depthStep };
  }

  /* ─── Camera ─── */

  /**
   * Ease the camera toward the ball, clamped so a goal mouth is always on
   * screen at each end.
   * @param {number} ballX
   * @param {boolean} [snap] - jump rather than ease (kickoff, restart)
   */
  function follow(ballX, snap) {
    /* Overscan by the goal depth at each end: the nets sit behind the goal
       line, so a camera clamped exactly to the pitch never shows them. */
    const over = CONFIG.goalDepth * 1.5;
    const minCam = -over;
    const maxCam = Math.max(minCam, CONFIG.pitchW - CONFIG.cameraViewW + over);
    const target = Math.max(minCam, Math.min(maxCam, ballX - CONFIG.cameraViewW / 2));
    _camX = snap ? target : _camX + (target - _camX) * CONFIG.camLerp;
  }

  /** The camera window's left edge, in world units. */
  function camX() { return _camX; }

  /** Where a world point currently sits on the screen, in viewport pixels. */
  function toViewport(x, y) {
    const p = project(x, y);
    return { x: p.sx - _camX * L.zoom, y: p.sy };
  }

  /* ─── Feel ─── */

  /**
   * Zoom punch - a quick scale up and back, centred on a world point.
   * @param {number} [scale] - peak scale, defaults to CONFIG.zoomPunch
   * @param {number} [x] - world x to centre on
   * @param {number} [y] - world y to centre on
   */
  function punch(scale, x, y) {
    /* Snap to the peak, then ease back to 1 over the next few frames. */
    _punch = scale || CONFIG.zoomPunch;
    _punchTarget = 1;
    if (x != null) {
      const v = toViewport(x, y == null ? CONFIG.pitchH / 2 : y);
      _punchOx = Math.max(0, Math.min(1, v.x / L.viewW));
      _punchOy = Math.max(0, Math.min(1, v.y / L.viewH));
    }
  }

  /**
   * Shake the screen. Amplitude decays over the following frames.
   * @param {number} [px] - starting amplitude, defaults to CONFIG.shakePx
   */
  function shake(px) {
    _shake = Math.max(_shake, px == null ? CONFIG.shakePx : px);
  }

  /**
   * Advance the punch and shake decay and write the pitch transform.
   * Called once per rendered frame, after follow().
   * @param {number} dt - seconds since the last render
   */
  function stepFeel(dt) {
    if (_punch !== _punchTarget) {
      /* Frame-rate independent ease-out toward 1. */
      const k = 1 - Math.pow(0.0001, dt);
      _punch += (_punchTarget - _punch) * k;
      if (Math.abs(_punch - _punchTarget) < 0.002) _punch = _punchTarget;
    }
    if (_shake > 0.1) {
      _shake *= Math.pow(0.02, dt);
    } else {
      _shake = 0;
    }
    _applyCamera();
  }

  /** Write the layer transforms. */
  function _applyCamera() {
    if (!_pitch) return;
    const offset = -_camX * L.zoom;
    if (_world) _world.style.transform = `translate3d(${offset}px,0,0)`;
    if (_markings) _markings.style.transform = `translate3d(${offset}px,0,0)`;
    if (_fx) _fx.style.transform = `translate3d(${offset}px,0,0)`;
    /* The crowd drifts at a third of the pitch speed - cheap parallax depth. */
    if (_crowd) _crowd.style.transform = `translate3d(${offset * 0.34}px,0,0)`;

    const sx = _shake ? (Math.random() * 2 - 1) * _shake : 0;
    const sy = _shake ? (Math.random() * 2 - 1) * _shake : 0;
    _pitch.style.transformOrigin = `${_punchOx * 100}% ${_punchOy * 100}%`;
    _pitch.style.transform = `translate3d(${sx}px,${sy}px,0) scale(${_punch})`;
  }

  /* ─── Furniture ─── */

  /** Rebuild the pitch surface, lines, walls, goals and crowd for this size. */
  function _buildMarkings() {
    if (!_markings) return;
    const W = CONFIG.pitchW * L.zoom;
    const H = L.pitchScreenH;
    const top = L.pitchTop;
    const mouth = CONFIG.goalMouth * L.depthStep;
    const mouthTop = top + (CONFIG.pitchH - (CONFIG.pitchH + CONFIG.goalMouth) / 2) * L.depthStep;
    const depth = CONFIG.goalDepth * L.zoom;
    const cx = W / 2;
    const circleR = 180 * L.zoom;
    const boxW = 300 * L.zoom;
    const boxH = 520 * L.depthStep;
    const boxTop = top + (CONFIG.pitchH - (CONFIG.pitchH + 520) / 2) * L.depthStep;

    _markings.style.width = W + 'px';
    _markings.innerHTML = `
      <div class="pm__surface" style="top:${top}px;height:${H}px;width:${W}px"></div>
      <div class="pm__line pm__halfway" style="top:${top}px;height:${H}px;left:${cx}px"></div>
      <div class="pm__circle" style="top:${top + H / 2 - circleR}px;left:${cx - circleR}px;width:${circleR * 2}px;height:${circleR * 2}px"></div>
      <div class="pm__spot" style="top:${top + H / 2 - 3}px;left:${cx - 3}px"></div>
      <div class="pm__box" style="top:${boxTop}px;left:0;width:${boxW}px;height:${boxH}px"></div>
      <div class="pm__box" style="top:${boxTop}px;left:${W - boxW}px;width:${boxW}px;height:${boxH}px"></div>
      <div class="pm__wall pm__wall--far"  style="top:${top}px;width:${W}px"></div>
      <div class="pm__wall pm__wall--near" style="top:${top + H}px;width:${W}px"></div>
      <div class="pm__endwall" style="top:${top}px;height:${mouthTop - top}px;left:0"></div>
      <div class="pm__endwall" style="top:${mouthTop + mouth}px;height:${top + H - mouthTop - mouth}px;left:0"></div>
      <div class="pm__endwall" style="top:${top}px;height:${mouthTop - top}px;left:${W - 6}px"></div>
      <div class="pm__endwall" style="top:${mouthTop + mouth}px;height:${top + H - mouthTop - mouth}px;left:${W - 6}px"></div>
      <div class="pm__goal pm__goal--left"  style="top:${mouthTop}px;height:${mouth}px;left:${-depth}px;width:${depth}px"></div>
      <div class="pm__goal pm__goal--right" style="top:${mouthTop}px;height:${mouth}px;left:${W}px;width:${depth}px"></div>
    `;
    if (_crowd) _crowd.style.width = (W + L.viewW) + 'px';
  }

  /** The layer characters and the ball are appended to. */
  function worldLayer() { return _world; }

  /** The layer particles, fireworks and ball trails are appended to. */
  function fxLayer() { return _fx; }

  /** The current layout. Read-only to callers. */
  function layout() { return L; }

  return {
    init, resize, setScene, project, screenToWorldDelta,
    follow, camX, toViewport, punch, shake, stepFeel,
    worldLayer, fxLayer, layout,
  };
})();
