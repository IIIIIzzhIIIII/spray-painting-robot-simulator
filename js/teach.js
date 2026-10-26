/* =========================================================
 * teach.js — 示教点记录、轨迹库持久化、关节插补回放
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot;
  const C = SB.CONFIG;
  const U = SB.U;

  const Teach = SB.Teach = {
    robot: null,
    points: [],
    saved: [],
    playing: false,
    opts: {},
    _index: -1,
    _from: null,
    _to: null,
    _elapsed: 0,
    _duration: 0,

    init(robot) {
      this.robot = robot;
      this.loadLibrary();
      this.refresh();
      return this;
    },

    refresh() {
      if (SB.UI) SB.UI.setTeachPoints(this.points);
    },

    refreshSaved(selectedId) {
      if (SB.UI) SB.UI.setSavedTrajectories(this.saved, selectedId);
    },

    record() {
      if (!this.robot) return null;
      const angles = this.robot.getJoints();
      const tcp = this.robot.getTCP().position;
      const point = {
        angles: angles.map((v) => Number(v.toFixed(3))),
        tcp: { x: +tcp.x.toFixed(4), y: +tcp.y.toFixed(4), z: +tcp.z.toFixed(4) },
        ts: Date.now()
      };
      this.points.push(point);
      this.refresh();
      return point;
    },

    removeAt(index) {
      if (index < 0 || index >= this.points.length) return false;
      this.points.splice(index, 1);
      this.refresh();
      return true;
    },

    clear() {
      this.points = [];
      this.refresh();
    },

    isValidPoint(p) {
      return !!p && Array.isArray(p.angles) && p.angles.length === 6 &&
        p.angles.every((v) => typeof v === 'number' && isFinite(v));
    },

    setPoints(points) {
      const list = Array.isArray(points) ? points.filter((p) => this.isValidPoint(p)) : [];
      this.points = list.map((p) => ({
        angles: p.angles.slice(),
        tcp: p.tcp ? { x: p.tcp.x, y: p.tcp.y, z: p.tcp.z } : null,
        ts: p.ts || 0
      }));
      this.refresh();
      return this.points.length;
    },

    loadLibrary() {
      let arr = [];
      try {
        const raw = localStorage.getItem(C.storageKeys.trajectories);
        const data = raw ? JSON.parse(raw) : [];
        if (Array.isArray(data)) {
          arr = data.filter((t) => t && t.id && Array.isArray(t.points) && t.points.every((p) => this.isValidPoint(p)));
        }
      } catch (e) { arr = []; }
      this.saved = arr;
      this.refreshSaved();
    },

    persist() {
      try {
        localStorage.setItem(C.storageKeys.trajectories, JSON.stringify(this.saved));
        return true;
      } catch (e) {
        return false;
      }
    },

    save(name, extra) {
      if (!this.points.length) return null;
      const record = {
        id: U.uid(),
        name: String(name || '').trim() || ('轨迹 ' + (this.saved.length + 1)),
        created: new Date().toISOString(),
        points: U.clone(this.points),
        material: extra && extra.material ? extra.material : null,
        params: extra && extra.params ? U.clone(extra.params) : null
      };
      this.saved.unshift(record);
      if (this.saved.length > 30) this.saved.length = 30;
      const ok = this.persist();
      this.refreshSaved(record.id);
      return ok ? record : null;
    },

    load(id) {
      const rec = this.saved.filter((t) => t.id === id)[0];
      if (!rec) return null;
      this.setPoints(rec.points);
      this.refreshSaved(id);
      return rec;
    },

    removeSaved(id) {
      const before = this.saved.length;
      this.saved = this.saved.filter((t) => t.id !== id);
      if (this.saved.length === before) return false;
      this.persist();
      this.refreshSaved();
      return true;
    },

    startPlayback(opts) {
      if (!this.robot || this.points.length < 2) return false;
      this.stopPlayback(false);
      this.opts = opts || {};
      this.playing = true;
      this._index = -1;
      this._from = this.robot.getJoints();
      this._to = null;
      this._elapsed = 0;
      this._duration = 0;
      if (this.opts.onStart) this.opts.onStart(this.points.length);
      this.next();
      return this.playing;
    },

    next() {
      if (!this.playing) return;
      this._index++;
      if (this._index >= this.points.length) {
        this.finish();
        return;
      }
      this._to = this.points[this._index].angles.slice();
      this._elapsed = 0;
      this._duration = this.segmentDuration(this._from, this._to);
    },

    segmentDuration(a, b) {
      const speed = Math.max(5, (this.opts && this.opts.speed) || 55);
      let max = 0;
      for (let i = 0; i < 6; i++) {
        max = Math.max(max, Math.abs(U.norm180(b[i] - a[i])));
      }
      return U.clamp(max / speed, 0.35, 4.0);
    },

    apply(t) {
      if (!this._from || !this._to) return;
      const e = t * t * (3 - 2 * t);
      const angles = U.lerpJoints(this._from, this._to, e);
      this.robot.setJoints(angles);
      if (this.opts.onUpdate) this.opts.onUpdate(angles.slice(), this._index);
    },

    update(dt) {
      if (!this.playing) return;
      let remain = Math.min(dt, 0.1);
      let guard = 0;
      while (remain > 0 && this.playing && guard++ < 12) {
        if (!this._to) {
          this.next();
          if (!this.playing) return;
        }
        const need = this._duration - this._elapsed;
        if (remain < need) {
          this._elapsed += remain;
          this.apply(this._elapsed / this._duration);
          return;
        }
        remain -= Math.max(0, need);
        this.apply(1);
        this._from = this._to.slice();
        this._elapsed = 0;
        this.next();
      }
    },

    finish() {
      this.playing = false;
      this._to = null;
      this._from = null;
      if (this.opts.onDone) this.opts.onDone();
    },

    stopPlayback(notify) {
      const was = this.playing;
      this.playing = false;
      this._to = null;
      this._from = null;
      this._index = -1;
      if (was && notify !== false && this.opts.onStop) this.opts.onStop();
    }
  };
})();