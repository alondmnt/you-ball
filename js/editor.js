/**
 * Editor - build characters from your own pictures, put them in teams.
 *
 * Kid-first, so it is almost entirely pictures: tap a character, tap a slot,
 * pick a photo, drag and pinch until it sits right, tap the tick. The character
 * runs on the spot the whole time you are editing it, wearing what you have
 * given it so far.
 *
 * Nothing leaves the device. There is no share button and no upload, because
 * the pictures are of real children. Parts go into IndexedDB, roster and team
 * metadata into localStorage.
 */
const Editor = (() => {
  const BALL_ID = '__ball';   /* the ball is a slot too, on its own pseudo-character */

  let _progress = null;
  let _urls = {};
  let _selected = null;       /* roster character id being edited */
  let _preview = null;        /* the live-running rig */
  let _moodTimer = null;
  let _onPlay = null;
  let _pendingSlot = null;    /* slot awaiting a file pick */

  /* The poses the preview cycles through, one per face slot. Each pose already
     names the face it wears, so this order is the order the faces appear in. */
  const MOODS = ['run', 'celebrate', 'sad-dance'];
  const MOOD_MS = 1900;
  let _picking = null;        /* { team, place } the picker is choosing for */

  /* Adjust-overlay state. */
  let _adj = null;            /* { img, slot, view, paper, canvas } */
  const _pointers = new Map();
  let _pinchStart = 0, _pinchScale = 1, _dragFrom = null;

  /**
   * Bind the editor once.
   * @param {function} onPlay - called when the player taps play
   */
  function init(onPlay) {
    _onPlay = onPlay;
    document.getElementById('editor-back').addEventListener('click', () => { Audio.play('tap'); onPlay(); });
    document.getElementById('editor-play').addEventListener('click', () => { Audio.play('tap'); onPlay(); });
    document.getElementById('file-input').addEventListener('change', _onFilePicked);
    document.getElementById('adjust-cancel').addEventListener('click', _closeAdjust);
    document.getElementById('adjust-ok').addEventListener('click', _commitAdjust);
    document.getElementById('adjust-paper').addEventListener('click', _togglePaper);
    _bindAdjustGestures();
    document.getElementById('picker-close').addEventListener('click', _closePicker);
    /* Tapping the backdrop, but not the card, closes without changing anything. */
    document.getElementById('picker').addEventListener('click', e => {
      if (e.target.id === 'picker') _closePicker();
    });
    window.addEventListener('resize', _sizePreview);
    window.addEventListener('orientationchange', _sizePreview);
  }

  /**
   * Show the editor.
   * @param {object} progress - the live save, mutated in place
   */
  async function open(progress) {
    _progress = progress;
    if (!_progress.roster.length) {
      /* A brand new save gets one character, placed in the home team's first
         field place - the player the human is driving at kickoff - so making a
         face and pressing play actually shows it.
         This is the only automatic assignment there is. Dropping every new
         character into both teams is what made the editor read as though it
         edited both sides at once. */
      const seed = _addCharacter(false);
      _progress.teams[0].players[1] = seed.id;
      Storage.saveProgress(_progress);
    }
    if (!_selected || !_find(_selected)) _selected = _progress.roster[0].id;
    await _refreshUrls();
    render();
  }

  /** Re-read every part URL the editor needs. */
  async function _refreshUrls() {
    const keys = [];
    for (const c of _progress.roster) {
      for (const slot of Assets.allSlotKeys()) keys.push(Storage.partKey(c.id, slot));
    }
    keys.push(Storage.partKey(BALL_ID, 'ball'));
    _urls = await Storage.loadPartUrls(keys);
  }

  /** Find a roster record. */
  function _find(id) { return _progress.roster.find(c => c.id === id) || null; }

  /**
   * Add a character to the roster.
   * @param {boolean} [select] - make it the one being edited
   * @returns {object} the new record
   */
  function _addCharacter(select) {
    const id = 'c' + (_progress.nextId++);
    const record = {
      id,
      name: '',
      /* A random built-in head, so a brand new character already has a face. */
      head: Math.floor(Math.random() * Assets.HEAD_VARIANTS.length),
      slots: {},
    };
    _progress.roster.push(record);
    if (select !== false) _selected = id;
    Storage.saveProgress(_progress);
    return record;
  }

  /* ─── Rendering ─── */

  /** Rebuild the whole editor body. */
  function render() {
    const body = document.getElementById('editor-body');
    if (!body) return;
    body.innerHTML = `
      <div class="ed__roster" id="ed-roster"></div>
      <div class="ed__main">
        <div class="ed__stage" id="ed-stage"></div>
        <div class="ed__slots" id="ed-slots"></div>
      </div>
      <div class="ed__teams" id="ed-teams"></div>
    `;
    _renderRoster();
    _renderStage();
    _renderSlots();
    _renderTeams();
    /* Last, not inside _renderStage: the stage only reaches its final height
       once the team rows below it have been filled in. */
    _sizePreview();
  }

  /** The strip of characters, plus the button that makes a new one. */
  function _renderRoster() {
    const host = document.getElementById('ed-roster');
    host.innerHTML = '';
    for (const c of _progress.roster) {
      const card = document.createElement('button');
      card.className = 'ed__card' + (c.id === _selected ? ' ed__card--on' : '');
      card.type = 'button';
      const img = document.createElement('img');
      img.src = Character.faceSrc(c, 'idle', _teamColourOf(c.id), _urls);
      img.alt = '';
      card.appendChild(img);
      card.addEventListener('click', () => {
        Audio.play('tap');
        _selected = c.id;
        render();
      });
      host.appendChild(card);
    }

    const add = document.createElement('button');
    add.className = 'ed__card ed__card--add';
    add.type = 'button';
    add.textContent = '+';
    add.setAttribute('aria-label', 'new character');
    add.addEventListener('click', () => { Audio.play('confirm'); _addCharacter(true); render(); });
    host.appendChild(add);

    const del = document.createElement('button');
    del.className = 'ed__card ed__card--del';
    del.type = 'button';
    del.textContent = '🗑';
    del.setAttribute('aria-label', 'delete this character');
    del.addEventListener('click', _deleteSelected);
    host.appendChild(del);
  }

  /** The live preview: the selected character running on the spot. */
  function _renderStage() {
    const stage = document.getElementById('ed-stage');
    stage.className = 'ed__stage scene-' + _currentScene();
    stage.innerHTML = '';
    if (_moodTimer) { clearInterval(_moodTimer); _moodTimer = null; }
    const record = _find(_selected);
    if (!record) return;
    _preview = Character.create({
      record, colour: _teamColourOf(record.id), urls: _urls, badge: false,
    });
    stage.appendChild(_preview.el);

    /*
     * The preview plays each mood in turn rather than waiting to be tapped.
     * There are three face slots and no way to tell from the slots alone which
     * picture is used when; watching the player run, celebrate and then sulk
     * answers that without a word of explanation, and it shows off the faces a
     * kid has just drawn.
     *
     * setAnim alone is enough: every pose already names the face it wears.
     * setFace is deliberately not used - it pins the face until something
     * unpins it, which is why the old tap handler had to set both.
     */
    let mood = 0;
    const show = i => {
      mood = (i + MOODS.length) % MOODS.length;
      _preview.setAnim(MOODS[mood]);
    };
    show(0);
    _moodTimer = setInterval(() => {
      /* A hidden screen is display:none, which leaves offsetParent null. That
         is the cheapest way for this to notice it is no longer wanted, and it
         leaves nothing for anyone to remember to call on the way out. */
      if (!_preview || !stage.isConnected || stage.offsetParent === null) {
        clearInterval(_moodTimer);
        _moodTimer = null;
        return;
      }
      show(mood + 1);
    }, MOOD_MS);

    /* A tap skips ahead, for anyone who does not want to wait. Assigned rather
       than added: the stage element outlives every render, so listeners piled
       up on it and one tap eventually jumped several moods. */
    stage.onclick = () => { show(mood + 1); Audio.play('tap'); };
  }

  /**
   * Scale the preview to the stage it is standing in.
   *
   * A fixed scale in CSS clipped the character's head on a short landscape
   * screen, because the stage shrinks with the window but the rig did not.
   */
  function _sizePreview() {
    const stage = document.getElementById('ed-stage');
    if (!stage || !_preview) return;
    const h = stage.clientHeight;
    if (!h) return;
    const scale = Math.max(0.45, Math.min(2.6, (h * 0.8) / Assets.CHAR_H));
    _preview.el.style.transform = `scale(${scale})`;
  }

  /** One chip per slot. A chip with a custom picture gets a clear button. */
  function _renderSlots() {
    const host = document.getElementById('ed-slots');
    host.innerHTML = '';
    const record = _find(_selected);
    if (!record) return;

    for (const slot of Assets.SLOT_ORDER) {
      const def = Assets.SLOTS[slot];
      const has = !!record.slots[slot];
      const chip = document.createElement('div');
      chip.className = 'ed__chip' + (has ? ' ed__chip--set' : '');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ed__chip-btn';
      btn.title = def.label;
      btn.setAttribute('aria-label', def.label);
      btn.innerHTML = `<span class="ed__chip-icon">${def.icon}</span>`;
      btn.addEventListener('click', () => _pickFor(slot));
      chip.appendChild(btn);

      if (has) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'ed__chip-clear';
        clear.textContent = '✕';
        clear.setAttribute('aria-label', 'remove ' + def.label);
        clear.addEventListener('click', async () => {
          await Storage.deletePart(Storage.partKey(record.id, slot));
          delete record.slots[slot];
          Storage.saveProgress(_progress);
          await _refreshUrls();
          render();
        });
        chip.appendChild(clear);
      }

      /* The word, not just the picture. A title attribute is the only other
         label these had, and a tablet has no way to show one. */
      const word = document.createElement('span');
      word.className = 'ed__chip-word';
      word.textContent = def.label;
      chip.appendChild(word);
      host.appendChild(chip);
    }

    _sizePreview();
  }

  /**
   * Put a heading above a group of controls.
   *
   * These were icons with no words on purpose, for a reader who could not read
   * yet. That is no longer true, and four unlabelled rows of emoji is a puzzle
   * rather than a menu once you can read the answer.
   *
   * Each group is its own box so the row of them can wrap across the width
   * rather than stacking five deep down a narrow screen.
   *
   * @param {HTMLElement} host
   * @param {string} text - lower case, because that is what a new reader reads
   * @param {boolean} [full] - give the group a line of its own
   * @returns {HTMLElement} the group, to append the controls to
   */
  function _section(host, text, full) {
    const g = document.createElement('div');
    g.className = 'ed__group' + (full ? ' ed__group--full' : '');
    const h = document.createElement('div');
    h.className = 'ed__label';
    h.textContent = text;
    g.appendChild(h);
    host.appendChild(g);
    return g;
  }

  /** The two team strips, the colour pickers, the ball, and the match settings. */
  function _renderTeams() {
    const host = document.getElementById('ed-teams');
    host.innerHTML = '';

    const teamsGroup = _section(host, 'teams', true);
    for (let t = 0; t < 2; t++) {
      const team = _progress.teams[t];
      const row = document.createElement('div');
      row.className = 'ed__team';
      row.style.setProperty('--team-colour', team.colour);

      for (const colour of CONFIG.teamColours.concat(['#ffd166', '#06d6a0', '#9b5de5', '#f15bb5'])) {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'ed__swatch' + (colour === team.colour ? ' ed__swatch--on' : '');
        sw.style.background = colour;
        sw.setAttribute('aria-label', 'team colour');
        sw.addEventListener('click', () => {
          team.colour = colour;
          Storage.saveProgress(_progress);
          Audio.play('tap');
          render();
        });
        row.appendChild(sw);
      }

      for (let i = 0; i < 4; i++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'ed__slotcell' + (i === 0 ? ' ed__slotcell--gk' : '');
        const rec = _find(team.players[i]);
        if (rec) {
          const img = document.createElement('img');
          img.src = Character.faceSrc(rec, 'idle', team.colour, _urls);
          img.alt = '';
          cell.appendChild(img);
        } else {
          cell.textContent = '+';
        }
        cell.setAttribute('aria-label', (i === 0 ? 'goalkeeper' : 'player ' + i) + ', team ' + (t + 1));
        cell.addEventListener('click', () => _openPicker(t, i));
        row.appendChild(cell);
      }
      teamsGroup.appendChild(row);
    }

    /* The ball. It used to be one small picture at the head of a row of
       difficulty faces, which said nothing about what it was. The word above
       its own row is enough; it does not also need telling to tap it. */
    const ballGroup = _section(host, 'ball');
    const ballRow = document.createElement('div');
    ballRow.className = 'ed__extras';
    const ball = document.createElement('button');
    ball.type = 'button';
    ball.className = 'ed__ball';
    ball.setAttribute('aria-label', 'change the ball');
    const ballImg = document.createElement('img');
    ballImg.src = _urls[Storage.partKey(BALL_ID, 'ball')] || Assets.defaultBall();
    ballImg.alt = '';
    ball.appendChild(ballImg);
    ball.addEventListener('click', () => _pickFor('ball', BALL_ID));
    ballRow.appendChild(ball);
    ballGroup.appendChild(ballRow);

    /* Where you are playing. The stage behind the character changes as soon as
       you tap one, which is the other half of the explanation. */
    const fieldGroup = _section(host, 'field');
    const scenes = [['grass', '🌱', 'grass'], ['moon', '🌙', 'moon'],
                    ['pool', '🏊', 'pool'], ['ballpit', '🔴', 'ball pool']];
    const sceneRow = document.createElement('div');
    sceneRow.className = 'ed__extras';
    for (const [key, icon, word] of scenes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed__toggle ed__toggle--named' + (_currentScene() === key ? ' ed__toggle--on' : '');
      b.innerHTML = `<span class="ed__toggle-icon">${icon}</span><span class="ed__toggle-word">${word}</span>`;
      b.setAttribute('aria-label', key);
      b.addEventListener('click', () => {
        _progress.scene = key;
        Storage.saveProgress(_progress);
        Audio.play('tap');
        render();
      });
      sceneRow.appendChild(b);
    }
    fieldGroup.appendChild(sceneRow);

    const opponentGroup = _section(host, 'opponent');
    const diffRow = document.createElement('div');
    diffRow.className = 'ed__extras';
    const diffs = [['easy', '🙂', 'easy'], ['normal', '😀', 'normal'], ['hard', '😈', 'hard']];
    for (const [key, icon, word] of diffs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed__toggle ed__toggle--named' + (_progress.difficulty === key ? ' ed__toggle--on' : '');
      b.innerHTML = `<span class="ed__toggle-icon">${icon}</span><span class="ed__toggle-word">${word}</span>`;
      b.setAttribute('aria-label', key);
      b.addEventListener('click', () => {
        _progress.difficulty = key;
        CONFIG.difficulty = key;
        Storage.saveProgress(_progress);
        Audio.play('tap');
        render();
      });
      diffRow.appendChild(b);
    }
    opponentGroup.appendChild(diffRow);

    /* Two-player: one on the screen, one on the keyboard. */
    const playersGroup = _section(host, 'players');
    const playerRow = document.createElement('div');
    playerRow.className = 'ed__extras';
    for (const [n, icon, word] of [[1, '👤', 'one'], [2, '👤👤', 'two']]) {
      const on = (n === 2) === !!_progress.twoPlayer;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed__toggle ed__toggle--named' + (on ? ' ed__toggle--on' : '');
      b.innerHTML = `<span class="ed__toggle-icon">${icon}</span><span class="ed__toggle-word">${word}</span>`;
      b.setAttribute('aria-label', word + (n === 1 ? ' player' : ' players'));
      b.addEventListener('click', () => {
        _progress.twoPlayer = n === 2;
        CONFIG.twoPlayer = _progress.twoPlayer;
        Storage.saveProgress(_progress);
        Audio.play('tap');
        render();
      });
      playerRow.appendChild(b);
    }
    playersGroup.appendChild(playerRow);

    /*
     * Where each player stands. A separate choice from how many are playing,
     * because it is a different question - and in goal is a real place to
     * play here, not a novelty: a shot arrives at your goal every twelve
     * seconds and an opponent gets into your third every seven.
     *
     * One badged pair a seat, the way the key legend below is badged: two
     * humans on opposite sides each pick their own place. The pairs sit in one
     * wrapping row, so they run side by side where there is width for them and
     * stack where there is not, instead of always costing a second line. Each
     * pair is its own flex box so a wrap can only ever fall between players,
     * never between a player and half their choice.
     *
     * The second pair only exists when there is a second player, so a stale
     * choice cannot quietly apply to nobody.
     */
    const placeGroup = _section(host, 'your place');
    const places = _progress.inGoal || [];
    const seats = _progress.twoPlayer ? [0, 1] : [0];
    const placeRow = document.createElement('div');
    placeRow.className = 'ed__extras';
    for (const seat of seats) {
      const pair = document.createElement('div');
      pair.className = 'ed__place';
      if (_progress.twoPlayer) {
        const who = document.createElement('span');
        who.className = 'who' + (seat === 1 ? ' who--2' : '');
        who.textContent = String(seat + 1);
        pair.appendChild(who);
      }
      for (const [keeper, icon, word] of [[false, '\u26bd', 'out field'], [true, '\ud83e\udde4', 'in goal']]) {
        const on = keeper === !!places[seat];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ed__toggle ed__toggle--named' + (on ? ' ed__toggle--on' : '');
        b.innerHTML = `<span class="ed__toggle-icon">${icon}</span><span class="ed__toggle-word">${word}</span>`;
        b.setAttribute('aria-label',
          `player ${seat + 1} ${keeper ? 'in goal' : 'out field'}`);
        b.addEventListener('click', () => {
          const next = [!!places[0], !!places[1]];
          next[seat] = keeper;
          _progress.inGoal = next;
          CONFIG.inGoal = next.slice();
          Storage.saveProgress(_progress);
          Audio.play('tap');
          render();
        });
        pair.appendChild(b);
      }
      placeRow.appendChild(pair);
    }
    placeGroup.appendChild(placeRow);

    /* The keys, right under the choice that turns the second set on. Player
       two's row is dimmed until it is switched on, which is also the clearest
       way to say what that choice does. */
    const keysGroup = document.createElement('div');
    keysGroup.className = 'ed__group ed__group--full';
    const keys = document.createElement('div');
    keys.className = 'ed__keys';
    keys.innerHTML =
      `<div class="ed__keyrow"><span class="who">1</span>${Input.legendHtml(0, places[0])}</div>` +
      `<div class="ed__keyrow${_progress.twoPlayer ? '' : ' ed__keyrow--off'}">` +
      `<span class="who who--2">2</span>${Input.legendHtml(1, places[1])}</div>`;
    keysGroup.appendChild(keys);
    host.appendChild(keysGroup);

    if (Storage.partsUnavailable()) {
      const warn = document.createElement('div');
      warn.className = 'ed__warn';
      warn.textContent = 'pictures cannot be saved from a file:// page — serve the folder over http';
      host.appendChild(warn);
    }
  }

  /** The scene the save is set to, falling back to the config default. */
  function _currentScene() {
    const name = _progress.scene || CONFIG.scene;
    return CONFIG.scenes[name] ? name : 'grass';
  }

  /** The colour a character shows in, taken from whichever team it plays for. */
  function _teamColourOf(id) {
    for (const team of _progress.teams) {
      if (team.players.includes(id)) return team.colour;
    }
    return _progress.teams[0].colour;
  }

  /** Remove the selected character from the roster, its parts and its teams. */
  async function _deleteSelected() {
    const record = _find(_selected);
    if (!record || _progress.roster.length <= 1) return;
    for (const slot of Object.keys(record.slots)) {
      await Storage.deletePart(Storage.partKey(record.id, slot));
    }
    _progress.roster = _progress.roster.filter(c => c.id !== record.id);
    for (const team of _progress.teams) {
      team.players = team.players.map(id => (id === record.id ? null : id));
    }
    _selected = _progress.roster[0].id;
    Storage.saveProgress(_progress);
    await _refreshUrls();
    Audio.play('tap');
    render();
  }

  /* ─── Team place picker ─── */

  /*
   * Tap a place, tap a face.
   *
   * Assignment used to depend on which roster card happened to be selected,
   * which is a mode with nothing on screen to announce it. Two taps and no
   * mode: you can see what you are choosing and what you are choosing it for.
   */

  /**
   * Open the picker for one place in one team.
   * @param {number} team - 0 home, 1 away
   * @param {number} place - 0 is the goalkeeper, 1-3 are the field players
   */
  function _openPicker(team, place) {
    _picking = { team, place };
    Audio.play('tap');
    document.getElementById('picker-kit').style.background = _progress.teams[team].colour;
    /* A glove or a boot, so the place says what it is without a word of text. */
    document.getElementById('picker-role').textContent = place === 0 ? '🧤' : '👟';
    _renderPicker();
    document.getElementById('picker').classList.remove('overlay--hidden');
  }

  function _closePicker() {
    _picking = null;
    document.getElementById('picker').classList.add('overlay--hidden');
  }

  /** Every roster face, plus nobody, plus make a new one. */
  function _renderPicker() {
    const grid = document.getElementById('picker-grid');
    if (!grid || !_picking) return;
    const { team, place } = _picking;
    const colour = _progress.teams[team].colour;
    const current = _progress.teams[team].players[place];
    grid.innerHTML = '';

    for (const c of _progress.roster) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker__face' + (c.id === current ? ' picker__face--on' : '');
      const img = document.createElement('img');
      /* Drawn in this team's kit, so you see how they will look in it. */
      img.src = Character.faceSrc(c, 'idle', colour, _urls);
      img.alt = '';
      btn.appendChild(img);
      btn.addEventListener('click', () => _assign(c.id));
      grid.appendChild(btn);
    }

    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'picker__face picker__face--none' + (current == null ? ' picker__face--on' : '');
    none.textContent = '–';
    none.setAttribute('aria-label', 'nobody, use a built-in player');
    none.addEventListener('click', () => _assign(null));
    grid.appendChild(none);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'picker__face picker__face--add';
    add.textContent = '+';
    add.setAttribute('aria-label', 'new character');
    add.addEventListener('click', () => _assign(_addCharacter(true).id));
    grid.appendChild(add);
  }

  /**
   * Put a character, or nobody, in the place being picked for.
   * @param {string|null} id - roster id, or null to leave the place empty
   */
  function _assign(id) {
    if (!_picking) return;
    _progress.teams[_picking.team].players[_picking.place] = id;
    Storage.saveProgress(_progress);
    Audio.play('confirm');
    _closePicker();
    render();
  }

  /* ─── Import ─── */

  /**
   * Open the picker for a slot. On a tablet this offers the camera.
   * @param {string} slot
   * @param {string} [characterId] - defaults to the selected character
   */
  function _pickFor(slot, characterId) {
    _pendingSlot = { slot, id: characterId || _selected };
    const input = document.getElementById('file-input');
    input.value = '';         /* so picking the same file twice still fires */
    input.click();
  }

  async function _onFilePicked(e) {
    const file = e.target.files && e.target.files[0];
    if (!file || !_pendingSlot) return;
    try {
      const img = await Assets.loadImage(file);
      _openAdjust(img, _pendingSlot.slot, _pendingSlot.id);
    } catch (err) {
      _pendingSlot = null;
      alert(err.message || 'could not read that picture');
    }
  }

  /* ─── Adjust: drag to position, pinch or wheel to scale ─── */

  function _openAdjust(img, slot, id) {
    _pointers.clear();
    _pinchStart = 0; _dragFrom = null;
    const canvas = document.getElementById('adjust-canvas');
    _adj = { img, slot, id, view: Assets.fitView(img, slot), paper: false, canvas };
    const frame = Assets.frameSize(slot);
    /* Keep the on-screen frame the slot's aspect, whatever the slot is. */
    const box = document.querySelector('.adjust__frame');
    box.style.aspectRatio = `${frame.w} / ${frame.h}`;
    document.getElementById('adjust-paper').setAttribute('aria-pressed', 'false');
    document.getElementById('adjust-paper').classList.remove('btn--on');
    document.getElementById('adjust').classList.remove('overlay--hidden');
    _drawAdjust();
  }

  function _drawAdjust() {
    if (!_adj) return;
    Assets.renderCrop(_adj.img, _adj.slot, _adj.view, _adj.paper, _adj.canvas);
  }

  function _togglePaper() {
    if (!_adj) return;
    _adj.paper = !_adj.paper;
    const btn = document.getElementById('adjust-paper');
    btn.setAttribute('aria-pressed', String(_adj.paper));
    btn.classList.toggle('btn--on', _adj.paper);
    Audio.play('tap');
    _drawAdjust();
  }

  function _closeAdjust() {
    _adj = null;
    _pendingSlot = null;
    _pointers.clear();
    document.getElementById('adjust').classList.add('overlay--hidden');
  }

  async function _commitAdjust() {
    if (!_adj) return;
    const { slot, id } = _adj;
    const canvas = Assets.renderCrop(_adj.img, slot, _adj.view, _adj.paper);
    const blob = await Assets.toBlob(canvas);
    await Storage.putPart(Storage.partKey(id, slot), blob);

    if (id === BALL_ID) {
      _progress.ballCustom = true;
    } else {
      const record = _find(id);
      if (record) record.slots[slot] = true;
    }
    Storage.saveProgress(_progress);
    _closeAdjust();
    await _refreshUrls();
    Audio.play('confirm');
    render();
  }

  /** Drag pans the picture; two fingers or the wheel scale it. */
  function _bindAdjustGestures() {
    const frame = document.querySelector('.adjust__frame');
    if (!frame) return;

    frame.addEventListener('pointerdown', e => {
      if (!_adj) return;
      frame.setPointerCapture(e.pointerId);
      _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (_pointers.size === 1) _dragFrom = { x: e.clientX, y: e.clientY, vx: _adj.view.x, vy: _adj.view.y };
      if (_pointers.size === 2) { _pinchStart = _pinchDistance(); _pinchScale = _adj.view.scale; }
    });

    frame.addEventListener('pointermove', e => {
      if (!_adj || !_pointers.has(e.pointerId)) return;
      _pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (_pointers.size >= 2 && _pinchStart > 0) {
        const ratio = _pinchDistance() / _pinchStart;
        _adj.view.scale = Math.max(0.05, Math.min(12, _pinchScale * ratio));
      } else if (_dragFrom) {
        /* The canvas is drawn at frame resolution but shown larger, so a finger
           pixel is worth more than a canvas pixel. */
        const k = Assets.frameSize(_adj.slot).w / frame.getBoundingClientRect().width;
        _adj.view.x = _dragFrom.vx + (e.clientX - _dragFrom.x) * k;
        _adj.view.y = _dragFrom.vy + (e.clientY - _dragFrom.y) * k;
      }
      _drawAdjust();
    });

    const release = e => {
      _pointers.delete(e.pointerId);
      if (_pointers.size < 2) _pinchStart = 0;
      if (_pointers.size === 0) _dragFrom = null;
    };
    frame.addEventListener('pointerup', release);
    frame.addEventListener('pointercancel', release);

    frame.addEventListener('wheel', e => {
      if (!_adj) return;
      e.preventDefault();
      _adj.view.scale = Math.max(0.05, Math.min(12, _adj.view.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
      _drawAdjust();
    }, { passive: false });
  }

  /** Distance between the first two active pointers. */
  function _pinchDistance() {
    const [a, b] = [..._pointers.values()];
    return Math.hypot(b.x - a.x, b.y - a.y) || 1;
  }

  return { init, open, BALL_ID };
})();
