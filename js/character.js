/**
 * Character - builds a paper-doll rig from a roster record and drives its
 * animation state.
 *
 * The rig is six `<img>` slots (head, torso, two arms, two legs) on pivots,
 * plus two more head images so all three faces are in the DOM at once. Limbs
 * are never animated from JS: every state is a CSS class on the root, so the
 * whole thing stays on the compositor. The only per-frame JS write is the
 * root's own transform, which the renderer owns.
 *
 * Structure:
 *   .ch              <- renderer writes translate/scale/facing here
 *     .ch__shadow    <- outside .ch__body so it never tilts with a dive
 *     .ch__body      <- whole-body animation (bob, lean, jump)
 *       .ch__leg-l .ch__leg-r .ch__arm-l .ch__torso .ch__arm-r .ch__head
 */
const Character = (() => {

  /** Which face each animation state wears. Straight from the design table. */
  const ANIM_FACE = {
    idle: 'idle',
    run: 'idle',
    kick: 'idle',
    celebrate: 'goal',
    sad: 'sad',
    'sad-dance': 'sad',
    dive: 'idle',
  };

  /**
   * The src for one rig part, preferring an uploaded image and falling back
   * through the slot chain to the built-in illustrated part.
   * @param {object} rig - a RIG entry
   * @param {object} record - roster record ({ id, head, slots })
   * @param {string} colour - team colour
   * @param {Object<string, string>} urls - part key -> object URL
   * @param {string} [slotOverride] - resolve this slot instead of rig.slot
   *   (used for the two extra faces)
   * @returns {string}
   */
  function partSrc(rig, record, colour, urls, slotOverride) {
    const slot = slotOverride || rig.slot;
    const have = record && record.slots;
    const resolved = Assets.resolveSlot(slot, have);
    if (resolved && urls) {
      const url = urls[Storage.partKey(record.id, resolved)];
      if (url) return url;
    }
    const expr = slot === 'head_goal' ? 'goal' : slot === 'head_sad' ? 'sad' : 'idle';
    return Assets.defaultPart(rig.part, record, colour, expr);
  }

  /**
   * The face image for a record outside the rig - the score bar and the editor
   * roster both show a head on its own.
   * @param {object} record
   * @param {'idle'|'goal'|'sad'} expr
   * @param {string} colour
   * @param {Object<string, string>} urls
   * @returns {string} an image src
   */
  function faceSrc(record, expr, colour, urls) {
    const slot = expr === 'goal' ? 'head_goal' : expr === 'sad' ? 'head_sad' : 'head_idle';
    return partSrc({ part: 'head', slot }, record, colour, urls, slot);
  }

  /**
   * Build one character rig.
   * @param {object} opts
   * @param {object} opts.record - roster record, or null for a blank default
   * @param {string} opts.colour - team colour, tints the built-in parts
   * @param {Object<string, string>} [opts.urls] - part key -> object URL
   * @param {boolean} [opts.badge] - show the team badge on the torso
   * @returns {{el: HTMLElement, setAnim: function, setFace: function,
   *            setDiveDir: function, destroy: function}}
   */
  function create(opts) {
    const record = opts.record || { id: '_blank', head: 0, slots: {} };
    const colour = opts.colour || CONFIG.teamColours[0];
    const urls = opts.urls || {};

    const el = document.createElement('div');
    el.className = 'ch ch--idle ch--face-idle';
    el.style.setProperty('--team-colour', colour);

    const shadow = document.createElement('div');
    shadow.className = 'ch__shadow';
    el.appendChild(shadow);

    const body = document.createElement('div');
    body.className = 'ch__body';
    el.appendChild(body);

    /** Position one part image from its rig entry. */
    function _img(r, src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.draggable = false;
      img.style.left = r.x + 'px';
      img.style.top = r.y + 'px';
      img.style.width = r.w + 'px';
      img.style.height = r.h + 'px';
      img.style.transformOrigin = r.origin;
      img.style.zIndex = r.z;
      return img;
    }

    for (const rig of Assets.RIG) {
      if (rig.faces) {
        /* The head is three stacked images, one per expression. CSS picks the
           visible one, so scoring never waits on an image decode. */
        for (const [expr, slot] of Object.entries(rig.faces)) {
          const img = _img(rig, partSrc(rig, record, colour, urls, slot));
          img.className = `ch__part ch__head ch__face ch__face--${expr}`;
          body.appendChild(img);
        }
      } else {
        const img = _img(rig, partSrc(rig, record, colour, urls));
        img.className = `ch__part ch__${rig.part.replace('_', '-')}`;
        body.appendChild(img);
      }
    }

    if (opts.badge) {
      const badge = document.createElement('div');
      badge.className = 'ch__badge';
      body.appendChild(badge);
    }

    let anim = 'idle';
    let faceLock = null;

    /**
     * Switch animation state. Idempotent: the renderer calls this every frame
     * with whatever the world state implies, so re-issuing the current state
     * must not restart the keyframes. Nothing here runs a timer - how long a
     * kick lasts is a fact about the world, read from the player's kickAt.
     * @param {string} name - a key of ANIM_FACE
     */
    function setAnim(name) {
      if (!ANIM_FACE[name]) name = 'idle';
      if (name === anim) return;
      el.classList.remove('ch--' + anim);
      el.classList.add('ch--' + name);
      anim = name;
      if (!faceLock) _applyFace(ANIM_FACE[name]);
    }

    /**
     * Hold a face regardless of animation state, or release the hold.
     * The goal celebration uses this so a running player still grins.
     * @param {'idle'|'goal'|'sad'|null} expr - null releases
     */
    function setFace(expr) {
      faceLock = expr;
      _applyFace(expr || ANIM_FACE[anim]);
    }

    function _applyFace(expr) {
      el.classList.remove('ch--face-idle', 'ch--face-goal', 'ch--face-sad');
      el.classList.add('ch--face-' + expr);
    }

    /**
     * Which way a keeper tilts when diving.
     * @param {number} dir - +1 toward the far touchline, -1 toward the near one
     */
    function setDiveDir(dir) {
      el.style.setProperty('--dive-dir', dir < 0 ? -1 : 1);
    }

    /** Detach. The object URLs belong to Storage, which revokes them. */
    function destroy() { el.remove(); }

    return { el, setAnim, setFace, setDiveDir, destroy, getAnim: () => anim };
  }

  return { create, partSrc, faceSrc, ANIM_FACE };
})();
