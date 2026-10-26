/* =========================================================
 * nozzle.js — 喷嘴特写：扇形雾化粒子动态 + 湿膜堆积
 * 粒子形态由喷涂面积、压力、厚薄、走枪速度实时驱动
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot;
  const C = SB.CONFIG;
  const U = SB.U;

  const Nozzle = SB.Nozzle = {
    app: null,
    stage: null,
    canvas: null,
    ctx: null,
    w: 0,
    h: 0,
    dpr: 1,
    visible: false,
    params: null,
    materialId: 'putty',
    film: null,
    cols: 0,
    filmTarget: 450,
    particles: [],
    pmax: 900,
    pcount: 0,
    acc: 0,
    gunX: 0,
    gunDir: 1,
    splats: [],
    time: 0,
    _uiClock: 0,
    _geo: null,
    _metrics: null,

    init(app) {
      this.app = app;
      this.stage = document.getElementById('nozzleStage');
      this.canvas = document.getElementById('nozzleCanvas');
      if (!this.stage || !this.canvas) return;
      this.ctx = this.canvas.getContext('2d');
      this.pmax = U.isMobile() ? 520 : 900;
      this.particles = [];
      for (let i = 0; i < this.pmax; i++) {
        this.particles.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, size: 1, life: 0, max: 1, sat: false });
      }
      this.setParams((app && app.params) || C.materials.putty.defaults, (app && app.materialId) || 'putty', true);
      this.resize();
      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(this.stage);
      }
    },

    setParams(params, materialId, silent) {
      if (materialId && C.materials[materialId]) this.materialId = materialId;
      const mat = C.materials[this.materialId];
      if (!mat) return;
      const next = Object.assign({}, params || mat.defaults);
      const target = Math.max(5, Number(next.thickness) || mat.defaults.thickness);
      this.params = next;
      if (Math.abs((this.filmTarget || 0) - target) > 0.5) this.resetFilm();
      this.filmTarget = target;
      this.syncSliders();
      if (!silent) this.updateHudRuntime();
    },

    setVisible(on) {
      this.visible = !!on;
      if (on) {
        this.resize();
        this.syncSliders();
        this.updateHudRuntime();
      }
    },

    resetFilm() {
      this.cols = Math.max(60, Math.min(190, Math.round((this.w || 800) / 7)));
      this.film = new Float32Array(this.cols);
    },

    resize() {
      if (!this.stage || !this.canvas) return;
      const r = this.stage.getBoundingClientRect();
      this.w = Math.max(300, r.width);
      this.h = Math.max(200, r.height);
      this.dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      if (this.ctx) this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.resetFilm();
      this.gunX = this.w * 0.5;
    },

    syncSliders() {
      const mat = C.materials[this.materialId];
      if (!mat || !this.params) return;
      document.querySelectorAll('[data-noz-param]').forEach((el) => {
        const key = el.dataset.nozParam;
        const range = mat.range && mat.range[key];
        const meta = C.params[key];
        if (!range || !meta) return;
        const pad = Math.max((range[1] - range[0]) * 0.35, meta.step * 2);
        el.min = Math.max(meta.min, +(range[0] - pad).toFixed(4));
        el.max = Math.min(meta.max, +(range[1] + pad).toFixed(4));
        el.step = meta.step;
        el.value = this.params[key];
        if (SB.UI) SB.UI.updateSliderFill(el);
      });
      const set = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
      set('nozFanVal', U.fmt(this.params.fanWidth, 2) + ' m');
      set('nozPressureVal', U.fmt(this.params.pressure, 2) + ' MPa');
      set('nozThicknessVal', U.fmt(this.params.thickness, 0) + ' µm');
      set('nozSpeedVal', U.fmt(this.params.speed, 2) + ' m/s');
    },

    setHud(adaptive, materialId, params) {
      if (materialId) this.materialId = materialId;
      if (params) this.params = Object.assign({}, params);
      const mat = C.materials[this.materialId];
      if (!mat) return;
      const set = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
      set('nozCode', mat.code || '—');
      set('nozName', mat.name);
      set('nozSpec', mat.spec
        ? mat.spec.label + ' ' + mat.spec.value + ' · 目标干膜 ' + mat.spec.filmText
        : (mat.desc || ''));
      const badge = document.getElementById('nozAdaptiveBtn');
      if (badge) {
        badge.textContent = adaptive ? '自适应已开启' : '手动参数';
        badge.classList.toggle('on', !!adaptive);
      }
      this.syncSliders();
      this.updateHudRuntime();
    },

    metrics() {
      const mat = C.materials[this.materialId] || C.materials.putty;
      const p = this.params || mat.defaults;
      const pressure = Number(p.pressure) || mat.defaults.pressure;
      const d50 = U.clamp(58 / Math.pow(0.42 + pressure * 1.9, 0.62), 18, 110);
      const vel = 3.5 + pressure * 14;
      const baseFlow = (mat.props && mat.props.flow) || 0.5;
      const flow = baseFlow * Math.pow(pressure / Math.max(0.1, mat.defaults.pressure), 0.65);
      const solid = ((mat.props && mat.props.solid) || 100) / 100;
      const film = mat.spec ? mat.spec.film : p.thickness;
      const passes = Math.max(1, Math.ceil(film / Math.max(1, Number(p.thickness) * solid)));
      return { mat: mat, p: p, pressure: pressure, d50: d50, vel: vel, flow: flow, passes: passes };
    },

    updateHudRuntime() {
      const m = this.metrics();
      const set = (id, t) => { const e = document.getElementById(id); if (e) e.textContent = t; };
      set('nozD50', Math.round(m.d50) + ' µm');
      set('nozVel', m.vel.toFixed(1) + ' m/s');
      set('nozCount', String(this.pcount));
      set('nozPass', U.fmt(m.p.thickness, 0) + ' µm');
      set('nozFlow', m.flow.toFixed(2) + ' L/min');
      set('nozPasses', m.passes + ' 道');
      let max = 0;
      if (this.film) {
        for (let i = 0; i < this.film.length; i++) if (this.film[i] > max) max = this.film[i];
      }
      const pct = U.clamp(max / Math.max(1, this.filmTarget) * 100, 0, 100);
      const bar = document.getElementById('nozFilmBar');
      if (bar) bar.style.width = pct.toFixed(0) + '%';
      set('nozFilmPct', pct.toFixed(0) + '%');
    },

    update(dt) {
      if (!this.visible) return;
      const now = Math.min(dt || 0, 0.05);
      this.time += now;
      const m = this.metrics();
      this._metrics = m;
      const p = m.p;
      const mat = m.mat;
      const tipY = this.h * 0.30;
      const subY = this.h * 0.75;
      const physHalf = Math.atan((Number(p.fanWidth) * 0.5) / Math.max(0.1, Number(p.distance)));
      const visHalf = U.clamp(physHalf * 1.65, U.deg(6), U.deg(37));
      const fanHalf = Math.tan(visHalf) * (subY - tipY);
      const amp = Math.max(26, this.w * 0.20);
      const speedPx = 40 + (Number(p.speed) || 0.5) * 300;
      const defaultSpeedPx = 40 + (mat.defaults.speed || 0.5) * 300;

      this.gunX += this.gunDir * speedPx * now;
      if (this.gunX > this.w * 0.5 + amp) { this.gunX = this.w * 0.5 + amp; this.gunDir = -1; }
      if (this.gunX < this.w * 0.5 - amp) { this.gunX = this.w * 0.5 - amp; this.gunDir = 1; }

      // 湿膜堆积：默认枪速下一道达到目标湿膜，枪速越快单道越薄
      if (this.film) {
        const filmPerSec = this.filmTarget * defaultSpeedPx / Math.max(30, fanHalf * 2);
        const colW = this.w / this.cols;
        for (let i = 0; i < this.cols; i++) {
          const x = (i + 0.5) * colW;
          const d = Math.abs(x - this.gunX);
          if (d <= fanHalf) {
            const edge = 1 - 0.35 * Math.pow(d / Math.max(1, fanHalf), 2);
            this.film[i] = Math.min(this.filmTarget * 1.35, this.film[i] + filmPerSec * edge * now);
          }
        }
      }

      this._geo = {
        tipX: this.gunX, tipY: tipY, subY: subY, fanHalf: fanHalf,
        speedPx: speedPx, amp: amp, m: m
      };

      // 粒子发射
      const density = 0.8 + U.clamp((Number(p.thickness) || 0) / 1200, 0, 1) * 0.45;
      const rate = (420 + 80 * m.flow + 260 * (Number(p.pressure) || 0)) * density;
      this.acc += now * rate;
      let n = Math.min(14, Math.floor(this.acc));
      this.acc -= n;
      for (let k = 0; k < n; k++) this.spawnParticle(m, tipY, subY, fanHalf, speedPx);

      this.updateParticles(now, subY);
      this.updateSplats(now);

      this._uiClock += now;
      if (this._uiClock > 0.12) {
        this._uiClock = 0;
        this.updateHudRuntime();
      }
      this.render();
    },

    spawnParticle(m, tipY, subY, fanHalf, speedPx) {
      let slot = null;
      for (let i = 0; i < this.pmax; i++) {
        if (!this.particles[i].alive) { slot = this.particles[i]; break; }
      }
      if (!slot) return;
      const p = m.p;
      const tri = (Math.random() + Math.random() + Math.random()) / 1.5 - 1;
      const sat = Math.random() < 0.16;
      let offset = tri * fanHalf * 1.02;
      if (sat) offset *= 1.18;
      const travel = U.clamp(0.30 - (Number(p.pressure) || 0.4) * 0.20, 0.12, 0.30) * (0.85 + Math.random() * 0.35);
      const sx = this.gunX + (Math.random() - 0.5) * 4;
      const sy = tipY + 4;
      const targetX = this.gunX + offset;
      const size = U.clamp(m.d50 / 16, 1, 5) * (0.55 + Math.random() * 0.9) * (sat ? 0.55 : 1);
      slot.alive = true;
      slot.x = sx;
      slot.y = sy;
      slot.vx = (targetX - sx) / travel + this.gunDir * speedPx * 0.18;
      slot.vy = (subY - sy) / travel;
      slot.size = size;
      slot.life = travel * 1.05;
      slot.max = slot.life;
      slot.sat = sat;
      slot.seed = Math.random() * 6.28;
    },

    updateParticles(dt, subY) {
      for (let i = 0; i < this.pmax; i++) {
        const p = this.particles[i];
        if (!p.alive) continue;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 40 * dt;
        p.life -= dt;
        if (p.y >= subY) {
          p.alive = false;
          this.pcount--;
          this.addSplat(p.x, subY, p.size);
        } else if (p.life <= 0 || p.x < -30 || p.x > this.w + 30) {
          p.alive = false;
          this.pcount--;
        }
      }
      if (this.pcount < 0) this.pcount = 0;
    },

    addSplat(x, y, size) {
      if (this.splats.length > 48) this.splats.shift();
      this.splats.push({ x: x, y: y, r: size * 1.2, life: 0.24, max: 0.24 });
    },

    updateSplats(dt) {
      for (let i = this.splats.length - 1; i >= 0; i--) {
        const s = this.splats[i];
        s.life -= dt;
        s.r += 45 * dt;
        if (s.life <= 0) this.splats.splice(i, 1);
      }
    },

    rgba(hex, a) {
      const h = String(hex || '#E3E8EE').replace('#', '');
      const n = parseInt(h, 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    },

    render() {
      const ctx = this.ctx;
      const g = this._geo;
      if (!ctx || !g) return;
      this.drawBackground();
      this.drawCone(g);
      this.drawSubstrate(g);
      this.drawParticles(g);
      this.drawSplats();
      this.drawNozzle(g);
      this.drawAnnotations(g);
      this.drawVignette();
    },

    drawBackground() {
      const ctx = this.ctx, w = this.w, h = this.h;
      const bg = ctx.createRadialGradient(w * 0.5, h * 0.34, 30, w * 0.5, h * 0.5, Math.max(w, h) * 0.82);
      bg.addColorStop(0, '#13233a');
      bg.addColorStop(0.5, '#0a1422');
      bg.addColorStop(1, '#04080f');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(120,170,225,.07)';
      ctx.lineWidth = 1;
      const step = 46;
      for (let x = (w % step) / 2; x < w; x += step) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = (h % step) / 2; y < h; y += step) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(140,200,255,.16)';
      ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(w * 0.5, h * 0.12); ctx.lineTo(w * 0.5, h * 0.9); ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = 'rgba(150,200,255,.28)';
      ctx.lineWidth = 1.5;
      const c = 18;
      [[12, 12, 1, 1], [w - 12, 12, -1, 1], [12, h - 12, 1, -1], [w - 12, h - 12, -1, -1]].forEach((a) => {
        ctx.beginPath();
        ctx.moveTo(a[0] + a[2] * c, a[1]);
        ctx.lineTo(a[0], a[1]);
        ctx.lineTo(a[0], a[1] + a[3] * c);
        ctx.stroke();
      });
    },

    drawCone(g) {
      const ctx = this.ctx;
      const m = g.m;
      const color = m.mat.cssColor || '#E3E8EE';
      const left = g.tipX - g.fanHalf;
      const right = g.tipX + g.fanHalf;
      const grad = ctx.createLinearGradient(0, g.tipY, 0, g.subY);
      grad.addColorStop(0, this.rgba(color, 0.20));
      grad.addColorStop(0.55, this.rgba(color, 0.11));
      grad.addColorStop(1, this.rgba(color, 0.05));
      ctx.beginPath();
      ctx.moveTo(g.tipX, g.tipY);
      ctx.lineTo(right, g.subY);
      ctx.lineTo(left, g.subY);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // 扇幅边缘
      ctx.save();
      ctx.strokeStyle = this.rgba(color, 0.32);
      ctx.lineWidth = 1.2;
      ctx.setLineDash([5, 6]);
      ctx.beginPath();
      ctx.moveTo(g.tipX, g.tipY); ctx.lineTo(left, g.subY);
      ctx.moveTo(g.tipX, g.tipY); ctx.lineTo(right, g.subY);
      ctx.stroke();
      ctx.restore();

      // 中心雾束
      const core = g.fanHalf * 0.30;
      const cg = ctx.createLinearGradient(0, g.tipY, 0, g.subY);
      cg.addColorStop(0, this.rgba(color, 0.16));
      cg.addColorStop(1, this.rgba(color, 0.03));
      ctx.beginPath();
      ctx.moveTo(g.tipX, g.tipY);
      ctx.lineTo(g.tipX + core, g.subY);
      ctx.lineTo(g.tipX - core, g.subY);
      ctx.closePath();
      ctx.fillStyle = cg;
      ctx.fill();
    },

    drawSubstrate(g) {
      const ctx = this.ctx, w = this.w, h = this.h;
      const slabH = Math.max(10, h * 0.035);
      const sg = ctx.createLinearGradient(0, g.subY, 0, g.subY + slabH);
      sg.addColorStop(0, '#243247');
      sg.addColorStop(1, '#0d1727');
      ctx.fillStyle = sg;
      ctx.fillRect(0, g.subY, w, slabH);
      ctx.strokeStyle = 'rgba(150,190,235,.35)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(0, g.subY); ctx.lineTo(w, g.subY); ctx.stroke();

      const maxPx = Math.max(10, h * 0.055);
      const color = (this._metrics && this._metrics.mat.cssColor) || '#E3E8EE';
      if (this.film && this.cols) {
        ctx.beginPath();
        ctx.moveTo(0, g.subY);
        for (let i = 0; i <= this.cols; i++) {
          const v = this.film[Math.min(this.cols - 1, i)];
          const ratio = U.clamp(v / Math.max(1, this.filmTarget), 0, 1.35);
          const x = (i / this.cols) * w;
          const y = g.subY - ratio * maxPx;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, g.subY);
        ctx.closePath();
        const fg = ctx.createLinearGradient(0, g.subY - maxPx, 0, g.subY);
        fg.addColorStop(0, this.rgba(color, 0.92));
        fg.addColorStop(1, this.rgba(color, 0.52));
        ctx.fillStyle = fg;
        ctx.fill();
        ctx.strokeStyle = this.rgba(color, 0.95);
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }

      // 目标湿膜基准线
      ctx.save();
      ctx.strokeStyle = 'rgba(150,220,255,.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(0, g.subY - maxPx);
      ctx.lineTo(w, g.subY - maxPx);
      ctx.stroke();
      ctx.restore();
      ctx.font = '10px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(160,205,240,.7)';
      ctx.textAlign = 'right';
      ctx.fillText('目标湿膜 ' + U.fmt(this.filmTarget, 0) + ' µm', w - 14, g.subY - maxPx - 6);

      ctx.fillStyle = 'rgba(125,150,180,.65)';
      ctx.textAlign = 'left';
      ctx.font = '9.5px "Microsoft YaHei", sans-serif';
      ctx.fillText('基材', 14, g.subY + slabH * 0.72);
    },

    drawParticles(g) {
      const ctx = this.ctx;
      const color = g.m.mat.cssColor || '#E3E8EE';
      for (let i = 0; i < this.pmax; i++) {
        const p = this.particles[i];
        if (!p.alive) continue;
        const a = U.clamp(p.life / Math.max(0.001, p.max), 0, 1);
        const alpha = (p.sat ? 0.32 : 0.72) * a;
        ctx.strokeStyle = this.rgba(color, alpha * 0.55);
        ctx.fillStyle = this.rgba(color, alpha);
        ctx.lineWidth = Math.max(0.6, p.size * 0.65);
        ctx.beginPath();
        ctx.moveTo(p.x - p.vx * 0.010, p.y - p.vy * 0.010);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.5, p.size), 0, Math.PI * 2);
        ctx.fill();
        if (!p.sat && p.size > 1.6) {
          ctx.fillStyle = 'rgba(255,255,255,' + (alpha * 0.35).toFixed(2) + ')';
          ctx.beginPath();
          ctx.arc(p.x - p.size * 0.28, p.y - p.size * 0.28, Math.max(0.35, p.size * 0.32), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },

    drawSplats() {
      const ctx = this.ctx;
      const color = (this._metrics && this._metrics.mat.cssColor) || '#E3E8EE';
      for (let i = 0; i < this.splats.length; i++) {
        const s = this.splats[i];
        const a = U.clamp(s.life / s.max, 0, 1);
        ctx.strokeStyle = this.rgba(color, 0.45 * a);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(s.x, s.y, s.r, s.r * 0.35, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    },

    drawNozzle(g) {
      const ctx = this.ctx;
      const x = g.tipX;
      const tipY = g.tipY;
      const bodyW = Math.max(24, Math.min(40, this.w * 0.034));
      const bodyH = Math.max(46, this.h * 0.13);
      const topY = tipY - bodyH;

      // 输料软管
      ctx.save();
      ctx.strokeStyle = '#22334a';
      ctx.lineWidth = Math.max(6, bodyW * 0.28);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x - bodyW * 0.4, topY + 14);
      ctx.quadraticCurveTo(x - bodyW * 1.9, topY - 14, x - bodyW * 2.7, topY + 10);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(130,170,215,.22)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();

      // 枪体
      ctx.save();
      const bg = ctx.createLinearGradient(x - bodyW / 2, 0, x + bodyW / 2, 0);
      bg.addColorStop(0, '#1c2838');
      bg.addColorStop(0.28, '#63788f');
      bg.addColorStop(0.5, '#c4d3e2');
      bg.addColorStop(0.72, '#6b8098');
      bg.addColorStop(1, '#26364b');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(x - bodyW * 0.5, topY + 6);
      ctx.lineTo(x + bodyW * 0.5, topY + 6);
      ctx.lineTo(x + bodyW * 0.42, tipY - bodyH * 0.28);
      ctx.lineTo(x - bodyW * 0.42, tipY - bodyH * 0.28);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,210,240,.35)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 气帽
      ctx.fillStyle = '#394a60';
      ctx.beginPath();
      ctx.moveTo(x - bodyW * 0.62, tipY - bodyH * 0.28);
      ctx.lineTo(x + bodyW * 0.62, tipY - bodyH * 0.28);
      ctx.lineTo(x + bodyW * 0.40, tipY - 8);
      ctx.lineTo(x - bodyW * 0.40, tipY - 8);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,210,240,.28)';
      ctx.stroke();

      // 喷嘴尖端
      ctx.fillStyle = '#FFCC00';
      ctx.fillRect(x - 2, tipY - 9, 4, 9);
      ctx.fillStyle = 'rgba(255,204,0,.35)';
      ctx.beginPath();
      ctx.arc(x, tipY + 2, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // 枪速方向指示
      const dir = this.gunDir > 0 ? 1 : -1;
      ctx.save();
      ctx.strokeStyle = 'rgba(140,200,255,.5)';
      ctx.fillStyle = 'rgba(140,200,255,.5)';
      ctx.lineWidth = 1.2;
      const ax = x + dir * (bodyW + 12);
      ctx.beginPath();
      ctx.moveTo(ax, topY + 16);
      ctx.lineTo(ax + dir * 26, topY + 16);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ax + dir * 26, topY + 16);
      ctx.lineTo(ax + dir * 20, topY + 12);
      ctx.lineTo(ax + dir * 20, topY + 20);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    },

    drawAnnotations(g) {
      const ctx = this.ctx;
      const m = g.m;
      const color = m.mat.cssColor || '#E3E8EE';

      // 扇幅标注（画布较矮时省略，HUD 中仍有数值）
      if (this.h >= 430) {
        const y = Math.min(this.h - 118, g.subY + this.h * 0.035 + 20);
        const x0 = g.tipX - g.fanHalf, x1 = g.tipX + g.fanHalf;
        ctx.save();
        ctx.strokeStyle = 'rgba(142,198,255,.55)';
        ctx.fillStyle = 'rgba(142,198,255,.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, y - 5); ctx.lineTo(x0, y + 5);
        ctx.moveTo(x1, y - 5); ctx.lineTo(x1, y + 5);
        ctx.moveTo(x0, y); ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x0, y); ctx.lineTo(x0 + 7, y - 3); ctx.lineTo(x0 + 7, y + 3); ctx.closePath();
        ctx.moveTo(x1, y); ctx.lineTo(x1 - 7, y - 3); ctx.lineTo(x1 - 7, y + 3); ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.fillStyle = 'rgba(170,210,245,.85)';
        ctx.textAlign = 'center';
        ctx.fillText('喷涂面积（扇幅）' + U.fmt(m.p.fanWidth, 2) + ' m', g.tipX, y + 17);
      }

      ctx.font = '9px "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(140,165,195,.6)';
      ctx.textAlign = 'left';
      ctx.fillText('HIGH-SPEED MICRO VIEW · 工艺预览', 14, this.h - 112);
      ctx.textAlign = 'right';
      ctx.fillStyle = this.rgba(color, 0.75);
      ctx.fillText('湿膜 ' + U.fmt(this.filmTarget, 0) + ' µm / 道', this.w - 14, g.subY + (this.h * 0.035) + 22);
    },

    drawVignette() {
      const ctx = this.ctx, w = this.w, h = this.h;
      const vg = ctx.createRadialGradient(w * 0.5, h * 0.45, Math.min(w, h) * 0.25, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(0.7, 'rgba(0,0,0,.10)');
      vg.addColorStop(1, 'rgba(0,0,0,.5)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);
    }
  };
})();
