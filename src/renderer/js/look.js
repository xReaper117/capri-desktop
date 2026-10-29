// She looks at your screen and says something about it: when you ask (her menu › Look at my screen),
// or on her own now and then (her menu, off until you turn it on). The first time, she tells you
// where the picture goes: to the AI behind her chat, on your PC with a local model, else to that
// service. Then: a picture of the screen she's on (main.js keeps it in memory a moment, never on
// disk), her eyes on the window in front while a scanline sweeps it, and one or two sentences from
// her AI, in character. Her chat remembers what she said, for a while.

import { fmt, rand } from './util.js';
import { clean, mood } from './chat.js';

const FIRST_AFTER = 2 * 60 * 1000; // turned on: her first look a couple of minutes later
const EVERY = [8, 15];             // then every 8 to 15 minutes…
const ACTIVE_MS = 90 * 1000;       // …if you're at your PC (the pointer moved lately)…
const SAME_WINDOW_MS = 25 * 60 * 1000; // …and on another window than last time (or a good while later)
// what her AI is asked about the picture
const PROMPT = 'This is a picture of the user\'s screen right now. If you see a small figure with a big red mane, that\'s you: leave it out. Name one concrete thing you really see on it (the app or website, a title, a picture, a word), then react to it in character: curious, playful or teasing. One or two short sentences, talking to them.';

// Her coach (menu › Game coach, or Ctrl+Alt+G): a look every `coachEverySec` seconds, and a tip.
const COACH_TICK_MS = 5000;  // how often she checks whether it's time
const COACH_AWAY_S = 120;    // no keyboard or mouse for this long: you're away, no look
const COACH_FAILS = 4;       // this many failed looks in a row and she stops by herself
const COACH_KEEP = 4;        // the tips she remembers, so she doesn't repeat them
const coachPrompt = (tips) => [
  'This is a picture of the user\'s screen right now. They are most likely playing a game (often War Thunder) with you open on the side, and want to play better. If you see a small figure with a big red mane, that\'s you: leave it out.',
  'Work out what they are doing and give ONE concrete, specific tip they can use right now.',
  'In a game: say which one if you can tell, read what the HUD, the minimap and the menus really show (vehicle or aircraft, game mode, health or damage, ammunition, enemies, objectives, position) and tell them what you would do next. In a menu, lobby or garage: one tip about their setup, loadout or progress. Not a game: one tip to do what they are doing better.',
  'Only use what you can actually read in the picture, never invent it: if it is unclear or a loading screen, say that in a few words instead.',
  'At most two short sentences, the tip first, a little of your character after. They are playing, so no long text.',
  tips.length ? `Tips you already gave, do not repeat them: ${tips.map((x) => `"${x}"`).join(' ')}` : '',
].filter(Boolean).join('\n');

export class Look {
  constructor({ capri, panel, brain, chat, guide, host, fx, voice, active }) {
    this.capri = capri;
    this.panel = panel;
    this.brain = brain;
    this.chat = chat;
    this.guide = guide;
    this.host = host;
    this.fx = fx;
    this.voice = voice;
    this.active = active; // () => ms since the pointer last moved
    this.auto = false;    // her menu: Look at my screen now and then
    this.asked = false;   // you've been told what it means, and said yes
    this.looking = false;
    this.nextAt = 0;
    this.lastFg = null;
    this.lastAt = 0;
    setInterval(() => this.tick(), 30000);
    // her coach
    this.coach = false;        // her menu: Game coach
    this.coachEvery = 30;      // seconds between two looks
    this.coachNext = 0;
    this.coachFails = 0;       // failed looks in a row
    this.coachBlacks = 0;      // looks that showed only black, in a row
    this.coachTips = [];
    this.coachLooking = false;
    this.silent = false;       // she's stopping herself and says why: no "coach off" on top of it
    this.configured = false;
    setInterval(() => this.coachTick(), COACH_TICK_MS);
  }

  get t() {
    return this.brain.t.look;
  }

  configure({ watchScreen, lookAsked, coach, coachEverySec }) {
    const on = Boolean(watchScreen);
    if (on && !this.auto) this.nextAt = Date.now() + FIRST_AFTER;
    this.auto = on;
    this.asked = Boolean(lookAsked);
    this.coachEvery = Math.max(10, Number(coachEverySec) || 30);
    const coachOn = Boolean(coach);
    if (coachOn !== this.coach) {
      this.coach = coachOn;
      this.coachFails = this.coachBlacks = 0;
      this.coachTips = [];
      if (coachOn) this.coachNext = Date.now() + 3000; // her first tip a moment after
      // (the first configure is the app starting: nothing to announce)
      if (this.configured && !this.silent) {
        this.panel.say({ kind: 'info', badge: 'COACH', face: coachOn ? 'smug' : 'calm', line: fmt(coachOn ? this.t.coachOn : this.t.coachOff, { sec: this.coachEvery }), hold: 4500 });
      }
    }
    this.configured = true;
  }

  // What looking means (where the picture goes), before the first time. True if you said yes.
  async ask({ auto = false, coach = false } = {}) {
    const where = await this.host.lookWhere().catch(() => ({}));
    const t = this.t;
    const model = where.model || '…';
    let yes = false;
    await this.guide.scene(async () => {
      this.capri.perform('curious', this.capri.towardCenter());
      const id = await this.guide.ask({
        face: 'look',
        line: t.ask,
        quote: [fmt(where.local ? t.local : t.online, { model, service: where.provider || '' }), coach ? fmt(t.coachNote, { sec: this.coachEvery }) : auto ? t.auto : ''].filter(Boolean).join('\n'),
        actions: [{ id: 'yes', label: t.yes, primary: true }, { id: 'no', label: t.no }],
      });
      yes = id === 'yes';
    });
    if (yes) {
      this.asked = true;
      await this.host.setConfig({ lookAsked: true, ...(auto && { watchScreen: true }), ...(coach && { coach: true }) });
    }
    return yes;
  }

  // From her menu or Ctrl+Alt+G: her coach on (she asks first, the first time) or off.
  async setCoach(on) {
    if (!on) {
      this.host.setConfig({ coach: false });
      return;
    }
    if (this.coach) return;
    if (!this.asked && !(await this.ask({ coach: true }))) return;
    await this.host.setConfig({ coach: true });
  }

  // Every `coachEvery` seconds, while you're at your PC: a look, a tip. Unlike her looks now and then,
  // no scanline, no sound and no moving about: you're playing, only the tip.
  async coachTick() {
    if (!this.coach || !this.asked || this.coachLooking || this.looking || Date.now() < this.coachNext) return;
    const { capri, panel } = this;
    if (capri.stowed || capri.dragging || this.chat.open || this.guide.running) return;
    // something else of hers is up (an answer, an alert, a reminder): that's what she wants you to see
    if (panel.visible && !['idle', 'info'].includes(panel.current?.kind)) return;
    if (((await this.host.idle().catch(() => 0)) || 0) > COACH_AWAY_S) { // away: she looks again soon
      this.coachNext = Date.now() + COACH_TICK_MS;
      return;
    }
    this.coachLooking = true;
    try {
      await this.coachLook();
    } finally {
      this.coachLooking = false;
      this.coachNext = Date.now() + this.coachEvery * 1000;
    }
  }

  async coachLook() {
    const t = this.t;
    const snap = await this.host.lookSnap({ coach: true });
    if (!this.coach) return; // stopped meanwhile
    if (!snap.ok) {
      // all black: a game in exclusive fullscreen is hidden from screen capture. Said once.
      if (snap.code === 'black' && ++this.coachBlacks === 1) {
        this.panel.say({ kind: 'info', badge: 'COACH', face: 'aside', line: t.coachBlack, hold: 14000 });
      }
      return this.coachFail(snap.error);
    }
    const res = await this.host.lookSay({ id: snap.id, persona: this.chat.lookPersona(), prompt: `${coachPrompt(this.coachTips)}\n${this.chat.languageNote()}` });
    if (!this.coach) return;
    if (!res.ok) {
      if (res.code === 'novision') return this.stopCoach(fmt(t.noVision, { model: String(res.model || '…').replace(/:latest$/, '') }));
      if (res.code === 'noai') return this.stopCoach(t.noAI);
      return this.coachFail(res.error || '…');
    }
    const text = clean(res.text).replace(/^["“«]\s*|\s*["”»]$/g, '');
    if (!text) return;
    this.coachFails = this.coachBlacks = 0;
    this.coachTips = [...this.coachTips, text].slice(-COACH_KEEP);
    this.chat.seen = { text, at: Date.now() };
    this.capri.wake(); // she stays up while you play (and comes back from her mask)
    this.panel.say({ kind: 'info', badge: 'COACH', face: mood(text), line: text, hold: Math.min(15000, Math.max(6000, 3000 + text.length * 60)) });
  }

  coachFail(error) {
    if (++this.coachFails >= COACH_FAILS) this.stopCoach(error);
  }

  // She stops by herself (nothing to look with, or too many failures in a row) and says why.
  async stopCoach(error) {
    this.silent = true;
    try {
      await this.host.setConfig({ coach: false });
    } finally {
      this.silent = false;
    }
    this.panel.say({ kind: 'info', badge: 'COACH', face: 'aside', line: fmt(this.t.coachStopped, { error: error || '…' }), hold: 9000 });
  }

  // From her menu: turned on (she asks first, the first time) or off.
  async setAuto(on) {
    if (!on) {
      this.host.setConfig({ watchScreen: false });
      return;
    }
    if (!this.asked && !(await this.ask({ auto: true }))) return;
    if (this.asked) await this.host.setConfig({ watchScreen: true });
    this.panel.say({ kind: 'info', face: 'smug', line: this.t.on, hold: 3500 });
  }

  // From her menu: one look, now.
  async once() {
    if (!this.asked && !(await this.ask())) return;
    this.now({ manual: true });
  }

  // On her own: now and then, when you're there, on another window than last time, and she's free.
  tick() {
    if (!this.auto || !this.asked || this.looking || Date.now() < this.nextAt) return;
    if (this.active() > ACTIVE_MS || !this.free()) return;
    const fg = this.capri.windows.fg;
    if (fg === this.lastFg && Date.now() - this.lastAt < SAME_WINDOW_MS) return;
    this.nextAt = Date.now() + rand(EVERY[0], EVERY[1]) * 60 * 1000;
    this.now();
  }

  free() {
    const { capri, panel } = this;
    if (capri.busy || capri.dragging || capri.stowed || capri.dormant || capri.hidden || capri.act || capri.pointing) return false;
    if (!['stand', 'sit'].includes(capri.stance) || capri.mode === 'alert' || capri.mode === 'sleep') return false;
    return !this.chat.open && !this.guide.running && !panel.visible;
  }

  // her eyes on the window in front (or the whole screen) while a scanline sweeps it
  effect() {
    const { wins, fg } = this.capri.windows;
    const win = wins.find((w) => w.id === fg && !w.max);
    const { w, floor } = this.capri.view;
    const rect = win ? () => this.capri.windows.wins.find((o) => o.id === win.id) || null : () => ({ x: 0, y: 0, w, h: floor });
    const toward = win ? Math.sign(win.x + win.w / 2 - this.capri.pos.x) || 1 : this.capri.towardCenter();
    this.capri.perform('curious', toward);
    this.fx.cutin(...this.capri.cutinAt(-toward), { kind: 'eyes', life: 520 });
    this.fx.scan(rect, { covers: () => (win ? this.capri.coversOf(win.id) : []) });
    this.voice.play('charge');
  }

  async now({ manual = false } = {}) {
    if (this.looking) return;
    this.looking = true;
    const t = this.t;
    try {
      if (manual) {
        if (this.capri.stowed) {
          this.host.setConfig({ visible: true });
          await this.capri.unstow();
        }
        this.capri.wake();
      }
      const snap = await this.host.lookSnap();
      if (!snap.ok) {
        if (manual) this.panel.say({ kind: 'info', face: 'aside', line: fmt(t.failed, { error: snap.error }), hold: 6000 });
        return;
      }
      this.lastFg = this.capri.windows.fg;
      this.lastAt = Date.now();
      this.effect();
      const res = await this.host.lookSay({ id: snap.id, persona: this.chat.lookPersona(), prompt: `${PROMPT}\n${this.chat.languageNote()}` });
      if (!res.ok) {
        if (res.code === 'novision') {
          // her model can't see: said once, and she stops trying on her own
          this.panel.say({ kind: 'info', face: 'aside', line: fmt(t.noVision, { model: String(res.model || '…').replace(/:latest$/, '') }), hold: 9000 });
          if (this.auto) this.host.setConfig({ watchScreen: false });
        } else if (manual) {
          this.panel.say({ kind: 'info', face: 'aside', line: res.code === 'noai' ? t.noAI : fmt(t.failed, { error: res.error || '…' }), hold: 7000 });
        }
        return;
      }
      const text = clean(res.text).replace(/^["“«]\s*|\s*["”»]$/g, ''); // no quotes around what she says
      if (!text) return;
      this.chat.seen = { text, at: Date.now() };
      this.panel.say({ kind: 'info', badge: 'SCAN', face: mood(text), line: text, hold: Math.min(13000, Math.max(5000, 2500 + text.length * 55)) });
    } finally {
      this.looking = false;
    }
  }
}

