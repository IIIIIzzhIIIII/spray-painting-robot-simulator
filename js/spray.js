/* =========================================================
 * spray.js — 墙面/天花板/地面涂层画布、覆盖率统计、耗料计算、喷涂粒子
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot;
  const C = SB.CONFIG;
  const U = SB.U;

  const Spray = SB.Spray = {
    sceneMgr: null,
    robot: null,
    surfaces: {},
    surface: 'wall',
    materialId: 'putty',
    color: '#F2ECDF',
    area: 0,
    consumption: 0,
    tank: 100,
    tankBase: 100,
    distance: 0,
    targetRect: null,
    targetArea: 3.9,
    particles: null,
    _pmax: 0,
    _pgeo: null,
    _pdata: null,
    _plife: null,
    _pvel: null,
    _pcolor: null,
    _pcount: 0,
    _phead: 0,
    _dirty: false,
    _uploadClock: 0,
    _emitAcc: 0,
    sprayOn: false,

    init(sceneMgr, robot) {
      this.sceneMgr = sceneMgr;
      this.robot = robot;
      this.buildSurfaces();
      this.buildParticles();
      this.setMaterial('putty');
      this.setTargetRect(null, 'wall');
      return this;
    },

    disposeSurfaces() {
      Object.keys(this.surfaces).forEach((key) => {
        const s = this.surfaces[key];
        if (s.mesh) {
          this.sceneMgr.scene.remove(s.mesh);
          s.mesh.geometry.dispose();
          s.mesh.material.dispose();
        }
        if (s.texture) s.texture.dispose();
      });
      this.surfaces = {};
    },

    createSurface(kind) {
      const f = C.surfaceFrame(kind);
      const mobile = U.isMobile();
      const wm = f.width;
      const hm = f.height;
      const base = f.isWall ? (mobile ? 1024 : 2048) : (mobile ? 640 : 1024);
      const pw = base;
      const ph = Math.max(128, Math.round(base * hm / wm));
      const cv = document.createElement('canvas');
      cv.width = pw;
      cv.height = ph;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.sceneMgr.renderer.capabilities.getMaxAnisotropy());
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(wm, hm), mat);
      const p = this.sceneMgr.surfacePoint(kind, 0, f.isWall ? f.height / 2 : (f.vMin + f.vMax) / 2, 0.014);
      mesh.position.copy(p);
      if (f.isWall) mesh.rotation.set(0, f.rotY, 0);
      else if (kind === 'ceiling') mesh.rotation.set(Math.PI / 2, 0, 0);
      else mesh.rotation.set(-Math.PI / 2, 0, 0);
      mesh.renderOrder = 3;
      mesh.name = 'PaintOverlay_' + kind;
      this.sceneMgr.scene.add(mesh);
      this.surfaces[kind] = {
        kind: kind,
        canvas: cv,
        ctx: cv.getContext('2d'),
        texture: tex,
        mesh: mesh,
        pxU: pw / wm,
        pxV: ph / hm,
        covered: new Set(),
        area: 0
      };
    },

    buildSurfaces() {
      this.disposeSurfaces();
      C.wallOrder.forEach((id) => this.createSurface(id));
      this.createSurface('ceiling');
      this.createSurface('floor');
      this.setSurface(this.surface || 'wall');
    },

    rebuild() {
      this.buildSurfaces();
      this.area = 0;
      this.distance = 0;
    },

    setSurface(kind) {
      if (!this.surfaces[kind]) return;
      this.surface = kind;
      this.area = this.surfaces[kind].area || 0;
    },

    setMaterial(id) {
      const m = C.materials[id];
      if (!m) return;
      this.materialId = id;
      this.color = m.cssColor;
    },

    setTargetRect(rect, surface) {
      const kind = surface || (rect && rect.surface) || this.surface || 'wall';
      this.setSurface(kind);
      this.targetRect = rect ? { minX: rect.minX, maxX: rect.maxX, minY: rect.minY, maxY: rect.maxY } : null;
      if (rect) {
        this.targetArea = Math.max(0.01, (rect.maxX - rect.minX) * (rect.maxY - rect.minY));
      } else {
        const d = C.isWallSurface(kind) ? C.defaultSelection : C.defaultSelectionFlat;
        this.targetArea = (d.maxX - d.minX) * (d.maxY - d.minY);
      }
      this.area = this.surfaces[kind] ? this.surfaces[kind].area : 0;
    },

    get coverage() {
      if (!this.targetArea) return 0;
      return U.clamp((this.area / this.targetArea) * 100, 0, 100);
    },

    setParticles(on) {
      if (this.particles) this.particles.visible = !!on;
      if (!on) this.killParticles();
    },

    clearSurface(kind) {
      const s = this.surfaces[kind];
      if (!s) return 0;
      s.ctx.clearRect(0, 0, s.canvas.width, s.canvas.height);
      s.covered.clear();
      s.area = 0;
      s.texture.needsUpdate = true;
      return 0;
    },

    clearWall() {
      Object.keys(this.surfaces).forEach((kind) => this.clearSurface(kind));
      this.area = 0;
    },

    refill() {
      this.consumption = 0;
      this.tankBase = 100;
      this.tank = 100;
    },

    setTankLevel(percent) {
      this.tankBase = U.clamp(percent, 0, 100);
      this.consumption = 0;
      this.tank = this.tankBase;
    },

    resetTask() {
      this.clearWall();
      this.consumption = 0;
      this.tankBase = 100;
      this.tank = 100;
      this.distance = 0;
      this.sprayOn = false;
      this.killParticles();
    },

    projectToSurface(tcp, direction, surface) {
      if (!tcp || !direction) return null;
      const kind = surface || this.surface;
      const f = C.surfaceFrame(kind);
      const n = new THREE.Vector3(f.normal[0], f.normal[1], f.normal[2]);
      const denom = direction.dot(n);
      if (denom > -0.18) return null;
      const anchor = new THREE.Vector3(f.anchor[0], f.anchor[1], f.anchor[2]);
      const t = n.dot(anchor.clone().sub(tcp)) / denom;
      if (!isFinite(t) || t < 0.05 || t > 1.5) return null;
      const point = tcp.clone().addScaledVector(direction, t);
      const rel = point.clone().sub(anchor);
      const u = rel.dot(new THREE.Vector3(f.uDir[0], f.uDir[1], f.uDir[2]));
      const v = rel.dot(new THREE.Vector3(f.vDir[0], f.vDir[1], f.vDir[2]));
      if (Math.abs(u) > f.width / 2 || v < f.vMin || v > f.vMax) return null;
      return { u: u, v: v, x: u, y: v, distance: t, surface: kind };
    },

    projectToWall(tcp, direction) {
      return this.projectToSurface(tcp, direction, 'wall');
    },

    sprayStep(dt, tcp, direction, params) {
      const hit = this.projectToSurface(tcp, direction, this.surface);
      if (!hit) { this.sprayOn = false; return; }
      this.sprayOn = true;
      this.distance = hit.distance;
      const fan = params.fanWidth || 0.3;
      const dist = params.distance || 0.3;
      const ratio = U.clamp(dist / Math.max(0.12, hit.distance), 0.8, 1.2);
      const radius = Math.max(0.05, fan * 0.5 * ratio);
      const thickness = params.thickness || 450;
      const added = this.markCoverage(hit.u, hit.v, radius, this.surface);
      if (added > 0) {
        const s = this.surfaces[this.surface];
        s.area = s.covered.size * this.cellArea();
        this.area = s.area;
        this.consumption += added * this.cellArea() * (thickness / 1000000) * C.consumptionFactor * 1000;
        this.tank = U.clamp(this.tankBase - (this.consumption / C.tankCapacity) * 100, 0, 100);
      }
      this.paintBlob(this.surface, hit.u, hit.v, radius, thickness);
      this.emitParticles(dt, tcp, direction);
    },

    markCoverage(u, v, radius, surface) {
      const R = C.room;
      const kind = surface || this.surface;
      const s = this.surfaces[kind];
      if (!s) return 0;
      const cell = C.coverageCell;
      const f = C.surfaceFrame(kind);
      const halfU = f.width / 2;
      const v0 = f.vMin;
      const maxIy = Math.floor(f.height / cell);
      const maxIx = Math.floor(f.width / cell);
      const ix0 = Math.floor((u - radius + halfU) / cell);
      const ix1 = Math.floor((u + radius + halfU) / cell);
      const iy0 = Math.floor((v - radius - v0) / cell);
      const iy1 = Math.floor((v + radius - v0) / cell);
      let added = 0;
      const r2 = radius * radius;
      for (let ix = Math.max(0, ix0); ix <= Math.min(maxIx, ix1); ix++) {
        const cx = -halfU + (ix + 0.5) * cell;
        for (let iy = Math.max(0, iy0); iy <= Math.min(maxIy, iy1); iy++) {
          const cy = v0 + (iy + 0.5) * cell;
          const dx = cx - u, dy = cy - v;
          if (dx * dx + dy * dy > r2) continue;
          // 有选区时覆盖率只统计选区内的网格，避免选区外过喷虚增覆盖率
          if (!this.inTargetRect(cx, cy)) continue;
          const key = ix * 1000 + iy;
          if (!s.covered.has(key)) {
            s.covered.add(key);
            added++;
          }
        }
      }
      return added;
    },

    inTargetRect(u, v) {
      const tr = this.targetRect;
      if (!tr) return true;
      return u >= tr.minX && u <= tr.maxX && v >= tr.minY && v <= tr.maxY;
    },

    paintBlob(surface, u, v, radius, thickness) {
      const kind = surface || this.surface;
      const s = this.surfaces[kind];
      if (!s) return;
      const R = C.room;
      const f = C.surfaceFrame(kind);
      const halfU = f.width / 2;
      const px = (u + halfU) * s.pxU;
      const py = f.isWall
        ? (f.height - v) * s.pxV
        : (kind === 'ceiling' ? (f.vMax - v) * s.pxV : (v - f.vMin) * s.pxV);
      const rx = Math.max(3, radius * s.pxU);
      const ry = Math.max(3, radius * s.pxV);
      const alpha = U.clamp(0.10 + ((thickness || 450) / 1000) * 0.035, 0.10, 0.24);
      const rgb = this.hexToRgb(this.color);
      const ctx = s.ctx;
      ctx.save();
      ctx.translate(px, py);
      ctx.scale(1, ry / rx);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, 'rgba(' + rgb + ',' + alpha.toFixed(3) + ')');
      g.addColorStop(0.72, 'rgba(' + rgb + ',' + (alpha * 0.92).toFixed(3) + ')');
      g.addColorStop(0.88, 'rgba(' + rgb + ',' + (alpha * 0.45).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + rgb + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      s.texture.needsUpdate = true;
    },

    hexToRgb(hex) {
      const h = String(hex).replace('#', '');
      const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
      return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
    },

    /* ---------- 批刮 / 打磨：矩形与去除操作 ---------- */
    markRect(u, v, hu, hv, surface) {
      const R = C.room;
      const kind = surface || this.surface;
      const s = this.surfaces[kind];
      if (!s) return 0;
      const cell = C.coverageCell;
      const f = C.surfaceFrame(kind);
      const halfU = f.width / 2;
      const v0 = f.vMin;
      const maxIy = Math.floor(f.height / cell);
      const maxIx = Math.floor(f.width / cell);
      const ix0 = Math.floor((u - hu + halfU) / cell);
      const ix1 = Math.floor((u + hu + halfU) / cell);
      const iy0 = Math.floor((v - hv - v0) / cell);
      const iy1 = Math.floor((v + hv - v0) / cell);
      let added = 0;
      for (let ix = Math.max(0, ix0); ix <= Math.min(maxIx, ix1); ix++) {
        const cx = -halfU + (ix + 0.5) * cell;
        for (let iy = Math.max(0, iy0); iy <= Math.min(maxIy, iy1); iy++) {
          const cy = v0 + (iy + 0.5) * cell;
          if (!this.inTargetRect(cx, cy)) continue;
          const key = ix * 1000 + iy;
          if (!s.covered.has(key)) {
            s.covered.add(key);
            added++;
          }
        }
      }
      return added;
    },

    paintRect(surface, u, v, hu, hv, thickness) {
      const kind = surface || this.surface;
      const s = this.surfaces[kind];
      if (!s) return;
      const R = C.room;
      const f = C.surfaceFrame(kind);
      const halfU = f.width / 2;
      const px = (u + halfU) * s.pxU;
      const py = f.isWall
        ? (f.height - v) * s.pxV
        : (kind === 'ceiling' ? (f.vMax - v) * s.pxV : (v - f.vMin) * s.pxV);
      const rx = Math.max(3, hu * s.pxU);
      const ry = Math.max(3, hv * s.pxV);
      const alpha = U.clamp(0.14 + ((thickness || 1800) / 1000) * 0.022, 0.14, 0.3);
      const ctx = s.ctx;
      ctx.save();
      ctx.fillStyle = 'rgba(' + this.hexToRgb(this.color) + ',' + alpha.toFixed(3) + ')';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(px - rx, py - ry, rx * 2, ry * 2, Math.min(rx, ry) * 0.7);
      else ctx.rect(px - rx, py - ry, rx * 2, ry * 2);
      ctx.fill();
      ctx.restore();
      s.texture.needsUpdate = true;
    },

    eraseCoverage(u, v, radius, surface) {
      const R = C.room;
      const kind = surface || this.surface;
      const s = this.surfaces[kind];
      if (!s) return 0;
      const cell = C.coverageCell;
      const f = C.surfaceFrame(kind);
      const halfU = f.width / 2;
      const v0 = f.vMin;
      const maxIy = Math.floor(f.height / cell);
      const maxIx = Math.floor(f.width / cell);
      const ix0 = Math.floor((u - radius + halfU) / cell);
      const ix1 = Math.floor((u + radius + halfU) / cell);
      const iy0 = Math.floor((v - radius - v0) / cell);
      const iy1 = Math.floor((v + radius - v0) / cell);
      const r2 = radius * radius;
      let removed = 0;
      for (let ix = Math.max(0, ix0); ix <= Math.min(maxIx, ix1); ix++) {
        const cx = -halfU + (ix + 0.5) * cell;
        for (let iy = Math.max(0, iy0); iy <= Math.min(maxIy, iy1); iy++) {
          const cy = v0 + (iy + 0.5) * cell;
          const dx = cx - u, dy = cy - v;
          if (dx * dx + dy * dy > r2) continue;
          if (s.covered.delete(ix * 1000 + iy)) removed++;
        }
      }
      return removed;
    },

    eraseBlob(surface, u, v, radius) {
      const kind = surface || this.surface;
      const s = this.surfaces[kind];
      if (!s) return;
      const R = C.room;
      const f = C.surfaceFrame(kind);
      const halfU = f.width / 2;
      const px = (u + halfU) * s.pxU;
      const py = f.isWall
        ? (f.height - v) * s.pxV
        : (kind === 'ceiling' ? (f.vMax - v) * s.pxV : (v - f.vMin) * s.pxV);
      const rx = Math.max(3, radius * s.pxU);
      const ry = Math.max(3, radius * s.pxV);
      const ctx = s.ctx;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,0.92)';
      ctx.beginPath();
      ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      s.texture.needsUpdate = true;
    },

    trowelStep(dt, tcp, direction, params) {
      const hit = this.projectToSurface(tcp, direction, this.surface);
      if (!hit) { this.sprayOn = false; return { added: 0 }; }
      this.sprayOn = true;
      this.distance = hit.distance;
      const halfW = U.clamp((params.fanWidth || 0.35) * 0.62, 0.1, 0.34);
      const halfH = 0.055;
      const thickness = params.thickness || 1800;
      const added = this.markRect(hit.u, hit.v, halfW, halfH, this.surface);
      if (added > 0) {
        const s = this.surfaces[this.surface];
        s.area = s.covered.size * this.cellArea();
        this.area = s.area;
        this.consumption += added * this.cellArea() * (thickness / 1000000) * C.consumptionFactor * 1000;
        this.tank = U.clamp(this.tankBase - (this.consumption / C.tankCapacity) * 100, 0, 100);
      }
      this.paintRect(this.surface, hit.u, hit.v, halfW, halfH, thickness);
      return { added: added };
    },

    sandStep(dt, tcp, direction, params) {
      const hit = this.projectToSurface(tcp, direction, this.surface);
      if (!hit) { this.sprayOn = false; return { removed: 0 }; }
      this.sprayOn = true;
      this.distance = hit.distance;
      const radius = U.clamp((params.fanWidth || 0.3) * 0.42, 0.08, 0.18);
      const removed = this.eraseCoverage(hit.u, hit.v, radius, this.surface);
      if (removed > 0) {
        const s = this.surfaces[this.surface];
        s.area = s.covered.size * this.cellArea();
        this.area = s.area;
      }
      this.eraseBlob(this.surface, hit.u, hit.v, radius);
      this.emitParticles(dt, tcp, direction, { dust: true });
      return { removed: removed };
    },

    cellArea() { return C.coverageCell * C.coverageCell; },

    buildParticles() {
      const max = U.isMobile() ? 260 : 600;
      this._pmax = max;
      const geo = new THREE.BufferGeometry();
      this._pdata = new Float32Array(max * 3);
      this._plife = new Float32Array(max);
      this._pvel = new Float32Array(max * 3);
      this._pcolor = new Float32Array(max * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
      geo.setDrawRange(0, 0);
      const mat = new THREE.PointsMaterial({
        size: 0.045, map: this.makeSprite(), transparent: true, depthWrite: false, opacity: 0.9,
        vertexColors: true, alphaTest: 0.02, sizeAttenuation: true
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 4;
      pts.visible = false;
      pts.name = 'SprayParticles';
      this.sceneMgr.scene.add(pts);
      this.particles = pts;
      this._pgeo = geo;
      this._pcount = 0;
    },

    makeSprite() {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 32;
      const ctx = cv.getContext('2d');
      const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.45, 'rgba(255,255,255,.75)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 32, 32);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    },

    emitParticles(dt, tcp, direction, opts) {
      if (!this.particles || !this.particles.visible) return;
      const dust = !!(opts && opts.dust);
      const mat = C.materials[this.materialId];
      const col = dust ? new THREE.Color(0xbfae92) : new THREE.Color(mat.color);
      this._emitAcc += dt * (dust ? 90 : 150);
      let n = Math.min(8, Math.floor(this._emitAcc));
      this._emitAcc -= n;
      if (n <= 0) return;
      const right = new THREE.Vector3(0, 1, 0).cross(direction);
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      right.normalize();
      const up = new THREE.Vector3().crossVectors(direction, right).normalize();
      for (let k = 0; k < n && this._pcount < this._pmax; k++) {
        const i = this._pcount++;
        const cone = dust ? 0.55 : 0.16;
        const sx = (Math.random() - 0.5) * cone;
        const sy = (Math.random() - 0.5) * cone;
        const speed = dust ? 0.9 + Math.random() * 0.9 : 3.0 + Math.random() * 1.2;
        const base = dust ? -0.45 : 1.0;
        this._pdata[i * 3] = tcp.x + (Math.random() - 0.5) * 0.012;
        this._pdata[i * 3 + 1] = tcp.y + (Math.random() - 0.5) * 0.012;
        this._pdata[i * 3 + 2] = tcp.z + (Math.random() - 0.5) * 0.012;
        this._pvel[i * 3] = direction.x * speed * base + right.x * sx + up.x * sy;
        this._pvel[i * 3 + 1] = direction.y * speed * base + right.y * sx + up.y * sy;
        this._pvel[i * 3 + 2] = direction.z * speed * base + right.z * sx + up.z * sy;
        this._plife[i] = dust ? 0.42 + Math.random() * 0.4 : 0.2 + Math.random() * 0.22;
        const tint = dust ? 0.82 + Math.random() * 0.25 : 1;
        this._pcolor[i * 3] = col.r * tint;
        this._pcolor[i * 3 + 1] = col.g * tint;
        this._pcolor[i * 3 + 2] = col.b * tint;
      }
    },

    update(dt) {
      if (this.particles && this.particles.visible && this._pcount > 0) {
        const pos = this._pdata, vel = this._pvel, life = this._plife, col = this._pcolor;
        const R = C.room;
        const wallZ = R.wallZ + 0.02;
        for (let i = this._pcount - 1; i >= 0; i--) {
          pos[i * 3] += vel[i * 3] * dt;
          pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
          pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
          vel[i * 3 + 1] -= 1.6 * dt;
          life[i] -= dt;
          const hitSurface = this.surface === 'ceiling'
            ? pos[i * 3 + 1] >= R.height - 0.02
            : this.surface === 'floor'
              ? pos[i * 3 + 1] <= 0.02
              : pos[i * 3 + 2] <= wallZ;
          if (life[i] <= 0 || hitSurface) {
            const last = --this._pcount;
            if (i !== last) {
              for (let k = 0; k < 3; k++) {
                pos[i * 3 + k] = pos[last * 3 + k];
                vel[i * 3 + k] = vel[last * 3 + k];
                col[i * 3 + k] = col[last * 3 + k];
              }
              life[i] = life[last];
            }
          }
        }
        const pa = this._pgeo.attributes.position;
        const ca = this._pgeo.attributes.color;
        pa.array.set(pos);
        ca.array.set(col);
        pa.needsUpdate = true;
        ca.needsUpdate = true;
        this._pgeo.setDrawRange(0, this._pcount);
      }
    },

    killParticles() {
      this._pcount = 0;
      if (this._pgeo) this._pgeo.setDrawRange(0, 0);
    },
    stats(info) {
      const data = info || {};
      const mat = C.materials[this.materialId];
      const p = data.params || mat.defaults;
      const digits = (key) => C.params[key].digits;
      const surfaceName = this.surface === 'ceiling' ? '天花板' : this.surface === 'floor' ? '地面' : '墙面';
      const rows = [
        { label: '涂料类型', value: mat.name + ' / ' + mat.en },
        { label: '作业面', value: surfaceName },
        { label: '作业面积', value: U.fmt(this.area, 2) + ' ㎡' },
        { label: '覆盖率', value: U.fmt(this.coverage, 1) + ' %' },
        { label: '平均涂层厚度', value: U.fmt(p.thickness, digits('thickness')) + ' µm' },
        { label: '物料消耗', value: U.fmt(this.consumption, 2) + ' L' },
        { label: '料桶余量', value: U.fmt(this.tank, 1) + ' %' },
        { label: '作业压力', value: U.fmt(p.pressure, digits('pressure')) + ' MPa' },
        { label: '移动速度', value: U.fmt(p.speed, digits('speed')) + ' m/s' },
        { label: '工具宽度', value: U.fmt(p.fanWidth, digits('fanWidth')) + ' m' },
        { label: '作业距离', value: U.fmt(p.distance, digits('distance')) + ' m' },
        { label: '任务用时', value: U.fmtTime(data.duration || 0) },
        { label: '示教点数', value: String(data.teachPoints == null ? 0 : data.teachPoints) + ' 点' }
      ];
      return {
        area: this.area,
        coverage: this.coverage,
        consumption: this.consumption,
        tank: this.tank,
        rows,
        csv: rows.map((r) => [r.label, r.value])
      };
    },

    dispose() {
      this.disposeSurfaces();
      if (this.particles) {
        this.sceneMgr.scene.remove(this.particles);
        this.particles.geometry.dispose();
        this.particles.material.dispose();
      }
    }
  };
})();