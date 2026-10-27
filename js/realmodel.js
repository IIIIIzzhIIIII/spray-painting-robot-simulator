/* =========================================================
 * realmodel.js — QZ-01 真实设备模型查看器（Draco 压缩 GLB）
 * 独立 Three.js 查看器，不影响主仿真场景
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot;
  const $ = (id) => document.getElementById(id);

  const RealModel = SB.RealModel = {
    viewer: null,
    loaded: false,
    loading: false,
    failed: false,
    raf: 0,
    _ro: null,

    init() {
      const btn = $('btnRealModel');
      if (btn) btn.addEventListener('click', () => this.open());
      const modal = $('realModelModal');
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal || e.target.closest('[data-close="realModelModal"]')) this.stop();
        });
      }
    },

    open() {
      SB.UI.openModal('realModelModal');
      if (!this.viewer) this.build();
      requestAnimationFrame(() => this.resize());
      this.startLoop();
      this.loadModel();
    },

    close() {
      SB.UI.closeModal('realModelModal');
      this.stop();
    },

    stop() {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    },

    build() {
      const canvas = $('realModelCanvas');
      const stage = canvas && canvas.parentElement;
      if (!canvas || !stage) return;

      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0d1726);
      const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 200);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.05;

      const controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.07;
      controls.rotateSpeed = 0.7;
      controls.zoomSpeed = 0.9;
      controls.minDistance = 1;
      controls.maxDistance = 30;

      scene.add(new THREE.HemisphereLight(0xdcecff, 0x7a6f62, 2.2));
      const sun = new THREE.DirectionalLight(0xfff3e0, 3.2);
      sun.position.set(5, 8, 6);
      scene.add(sun);
      const fill = new THREE.DirectionalLight(0xd9ecff, 1.6);
      fill.position.set(-4, 5, -5);
      scene.add(fill);
      scene.add(new THREE.AmbientLight(0xffffff, 0.5));

      const grid = new THREE.GridHelper(12, 24, 0x2c3f58, 0x1b2a3e);
      grid.position.y = -0.001;
      scene.add(grid);

      this.viewer = { scene, camera, renderer, controls, canvas, stage, box: null, model: null, center: new THREE.Vector3() };
      this.resize();

      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(stage);
      }
      this.startLoop();
    },

    resize() {
      const v = this.viewer;
      if (!v) return;
      const w = Math.max(1, v.stage.clientWidth);
      const h = Math.max(1, v.stage.clientHeight);
      v.renderer.setSize(w, h, false);
      v.camera.aspect = w / h;
      v.camera.updateProjectionMatrix();
    },

    loadModel() {
      if (this.loaded || this.loading) return;
      if (!THREE.GLTFLoader) {
        this.showError('GLTFLoader 未加载');
        return;
      }
      if (!THREE.DRACOLoader) {
        this.showError('DRACOLoader 未加载，无法解析 Draco 压缩模型');
        return;
      }
      this.loading = true;
      const loadingEl = $('realModelLoading');
      if (loadingEl) {
        loadingEl.classList.remove('hidden');
        loadingEl.textContent = '正在加载真实模型…';
      }
      const loader = new THREE.GLTFLoader();
      const draco = new THREE.DRACOLoader();
      draco.setDecoderPath('js/lib/draco/');
      loader.setDRACOLoader(draco);

      loader.load('models/real-bot.glb', (gltf) => {
        this.loading = false;
        this.loaded = true;
        const v = this.viewer;
        if (!v) return;
        const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
        root.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            const mats = Array.isArray(o.material) ? o.material : [o.material];
            mats.forEach((m) => {
              if (!m) return;
              m.side = THREE.DoubleSide;
            });
          }
        });
        v.scene.add(root);
        v.model = root;

        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        root.position.sub(center);
        box.setFromObject(root);
        root.position.y -= box.min.y;
        box.setFromObject(root);
        v.box = box;
        v.center = box.getCenter(new THREE.Vector3());

        this.frameCamera();
        this.renderOnce();

        let meshes = 0;
        const mats = new Set();
        root.traverse((o) => {
          if (!o.isMesh) return;
          meshes++;
          if (Array.isArray(o.material)) o.material.forEach((m) => mats.add(m));
          else if (o.material) mats.add(o.material);
        });
        const meta = $('realModelMeta');
        if (meta) {
          meta.textContent = '尺寸 ' + size.x.toFixed(2) + ' × ' + size.y.toFixed(2) + ' × ' + size.z.toFixed(2) +
            ' m · ' + meshes + ' 个网格 · ' + mats.size + ' 个材质 · 静态装配（无关节动画）';
        }
        if (loadingEl) loadingEl.classList.add('hidden');
        window.__realModelInfo = { size: size.toArray(), meshes: meshes, materials: mats.size, loaded: true };
      }, (evt) => {
        if (!loadingEl || !evt || !evt.total) return;
        const pct = Math.round((evt.loaded / evt.total) * 100);
        loadingEl.textContent = '正在加载真实模型… ' + pct + '%';
      }, (err) => {
        this.loading = false;
        this.failed = true;
        this.showError('模型加载失败：' + (err && err.message ? err.message : '请通过 http:// 本地服务器访问'));
      });
    },

    frameCamera() {
      const v = this.viewer;
      if (!v || !v.box) return;
      const size = v.box.getSize(new THREE.Vector3());
      const radius = size.length() * 0.5;
      const dist = radius / Math.sin(THREE.MathUtils.degToRad(v.camera.fov * 0.5)) * 1.15;
      v.camera.position.set(v.center.x + dist * 0.62, v.center.y + size.y * 0.25, v.center.z + dist * 0.78);
      v.controls.target.copy(v.center);
      v.controls.update();
    },

    showError(text) {
      const loadingEl = $('realModelLoading');
      if (loadingEl) {
        loadingEl.classList.remove('hidden');
        loadingEl.textContent = text;
      }
      const meta = $('realModelMeta');
      if (meta) meta.textContent = text;
    },

    startLoop() {
      if (this.raf) return;
      const tick = () => {
        const modal = $('realModelModal');
        if (!modal || modal.classList.contains('hidden')) {
          this.raf = 0;
          return;
        }
        this.raf = requestAnimationFrame(tick);
        if (!this.viewer) return;
        this.viewer.controls.update();
        this.viewer.renderer.render(this.viewer.scene, this.viewer.camera);
      };
      this.raf = requestAnimationFrame(tick);
    },

    renderOnce() {
      const v = this.viewer;
      if (v) v.renderer.render(v.scene, v.camera);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => RealModel.init());
  } else {
    RealModel.init();
  }
})();
