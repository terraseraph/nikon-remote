// Inspo panel: a picture-in-picture card over the live view showing real reference photos for
// a spoken or typed request ("inspo moody couple by a window"). Pinning one hands it to the
// pose matcher, which draws it as a ghost over the live view.

const $ = id => document.getElementById(id);

export class Inspo {
  constructor({ api, pose, toast, getModel }) {
    Object.assign(this, { api, pose, toast, getModel });
    this.photos = []; this.index = 0; this.pinned = null;
    $('inAsk').onsubmit = e => { e.preventDefault(); this.find($('inInput').value); };
    $('inInput').onkeydown = e => { if (e.key === 'Escape') this.close(); };
    $('inClose').onclick = () => this.close();
    $('inPrev').onclick = () => this.step(-1);
    $('inNext').onclick = () => this.step(+1);
    $('inPin').onclick = () => (this.pinned === this.current ? this.unpin() : this.pin());
    $('inSize').onclick = () => this.size();
    $('inImg').onclick = () => this.size();
    $('inEdit').onclick = () => this.ask();
  }

  get current() { return this.photos[this.index]; }
  get isOpen() { return !$('inspo').classList.contains('hidden'); }

  // Opens the panel with the search box, for typing a request.
  ask() {
    this.open();
    $('inAsk').classList.remove('hidden');
    $('inInput').focus(); $('inInput').select();
  }

  open() { $('inspo').classList.remove('hidden'); $('inspoBtn').classList.add('active'); }

  close() {
    if (this.pinned) this.unpin();
    $('inspo').classList.add('hidden'); $('inspoBtn').classList.remove('active');
  }

  toggle() { this.isOpen ? this.close() : this.ask(); }

  size(big = !$('inspo').classList.contains('big')) { $('inspo').classList.toggle('big', big); }

  async find(request) {
    request = String(request || '').trim();
    if (!request) return this.ask();
    this.open();
    this.busy?.abort();
    const ctl = (this.busy = new AbortController());
    $('inInput').value = request;
    $('inAsk').classList.add('hidden');
    $('inBusy').classList.remove('hidden');
    $('inBusyText').textContent = `Finding “${request}”…`;
    try {
      const r = await this.api('/api/inspo', { request, model: this.getModel() }, { signal: ctl.signal });
      if (ctl !== this.busy) return;
      this.photos = r.photos; this.index = 0;
      $('inQuery').textContent = request;
      $('inQuery').title = `Searched: ${r.queries.join(' · ')}`;
      $('inCue').textContent = r.cue;
      $('inCue').classList.toggle('hidden', !r.cue);
      this.renderStrip();
      this.show();
    } catch (e) {
      if (e.name === 'AbortError') return;
      this.toast(e.message, true);
      if (!this.photos.length) $('inAsk').classList.remove('hidden');
    } finally {
      if (ctl === this.busy) { this.busy = null; $('inBusy').classList.add('hidden'); }
    }
  }

  step(d) {
    if (!this.photos.length) return;
    this.index = (this.index + d + this.photos.length) % this.photos.length;
    this.show();
  }

  show() {
    const p = this.current;
    $('inspo').classList.toggle('has', !!p);
    if (!p) return;
    const img = $('inImg');
    // Read with CORS so the pose model can use its pixels. Sites without CORS (most Google results)
    // go through the server, and sites that block that too fall back to Google's own thumbnail.
    const proxied = u => `/api/inspo/img?u=${encodeURIComponent(u)}`;
    const tries = [p.full, proxied(p.full), ...(p.fallback ? [proxied(p.fallback)] : [])];
    img.crossOrigin = 'anonymous';
    img.onerror = () => {
      if (this.current !== p) return;
      const next = tries[tries.indexOf(img.getAttribute('src')) + 1];
      if (next) img.src = next;
    };
    img.src = p.full;
    img.alt = p.alt;
    $('inCount').textContent = `${this.index + 1}/${this.photos.length}`;
    const credit = $('inCredit');
    credit.href = p.link;
    credit.textContent = `${p.credit ? `${p.credit} · ` : ''}${p.source}${p.license ? ` · ${p.license}` : ''}`;
    for (const [i, t] of [...$('inStrip').children].entries()) t.classList.toggle('on', i === this.index);
    $('inStrip').children[this.index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    this.renderPin();
  }

  renderStrip() {
    $('inStrip').replaceChildren(...this.photos.map((p, i) => {
      const b = document.createElement('button');
      b.className = 'in-th'; b.setAttribute('aria-label', `Reference ${i + 1}`);
      const im = document.createElement('img');
      im.src = p.thumb; im.alt = ''; im.loading = 'lazy';
      b.append(im);
      b.onclick = () => { this.index = i; this.show(); };
      return b;
    }));
  }

  renderPin() {
    const on = !!this.pinned && this.pinned === this.current;
    $('inPin').textContent = on ? 'Unpin pose' : this.pinned ? 'Pin this one' : 'Match pose';
    $('inPin').classList.toggle('on', on);
    $('inspo').classList.toggle('pinned', !!this.pinned);
  }

  async pin() {
    const p = this.current, img = $('inImg');
    if (!p) return this.toast('Find some references first', true);
    $('inPin').disabled = true;
    $('inPin').textContent = 'Reading pose…';
    try {
      if (!img.complete || !img.naturalWidth) await new Promise((ok, bad) => { img.addEventListener('load', ok, { once: true }); img.addEventListener('error', bad, { once: true }); });
      await this.pose.pin(img);
      this.pinned = p;
      $('poseHud').classList.remove('hidden');
      this.toast('Pose pinned — line up with the outline');
    } catch (e) {
      this.toast(e.message || 'Couldn’t read that photo', true);
    } finally {
      $('inPin').disabled = false;
      this.renderPin();
    }
  }

  unpin() {
    this.pose.unpin();
    this.pinned = null;
    $('poseHud').classList.add('hidden');
    this.renderPin();
  }
}
