/* =========================================================
 * scene.js — 房间、灯光、相机、视图、框选与碰撞检测
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot;
  const C = SB.CONFIG;
  const U = SB.U;

  const Scene = SB.Scene = {
    ready: false,
    container: null,
    scene: null,
    camera: null,
    renderer: null,
    controls: null,
    sun: null,
    hemi: null,
    ambient: null,
    wallPlane: null,
    wallMeshes: [],
    obstacles: [],
    selection: null,
    pathPoints: null,
    selectionGroup: null,
    pathGroup: null,
    roomGroup: null,
    currentScene: 'residence',
    surface: 'wall',
    tween: null,
    quality: 'high',
    theme: 'light',
    _view: 'overview',
    follow: false,
    _followLast: null,

    init(container) {
      if (!window.THREE) throw new Error('Three.js 未加载');
      this.container = container;
      const width = container.clientWidth || 800;
      const height = container.clientHeight || 600;

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0xe9eef5);
      this.scene.fog = new THREE.Fog(0xe9eef5, 14, 26);

      this.camera = new THREE.PerspectiveCamera(46, width / height, 0.05, 90);
      this.camera.position.set(3.2, 3.0, 2.4);

      let renderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
      } catch (e) {
        throw new Error('当前浏览器/设备未启用 WebGL，无法运行 3D 仿真');
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.02;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.domElement.style.touchAction = 'none';
      container.appendChild(renderer.domElement);
      renderer.domElement.setAttribute('aria-label', '喷涂机器人三维仿真视图');
      this.renderer = renderer;

      this.controls = new THREE.OrbitControls(this.camera, renderer.domElement);
      this.controls.target.set(0, 1.35, -1.5);
      this.controls.enableDamping = true;
      this.controls.dampingFactor = 0.065;
      this.controls.rotateSpeed = 0.7;
      this.controls.panSpeed = 0.8;
      this.controls.zoomSpeed = 0.9;
      this.controls.minDistance = 1.0;
      this.controls.maxDistance = 20;
      this.controls.minPolarAngle = 0.08;
      this.controls.maxPolarAngle = Math.PI * 0.495;
      this.controls.screenSpacePanning = true;
      this.controls.addEventListener('start', () => { this.tween = null; });

      this.buildLights();
      this.buildRoom();
      this.buildPlanningObjects();

      this.wallPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -C.room.wallZ);
      this.raycaster = new THREE.Raycaster();
      this.pointer = new THREE.Vector2();
      this.resize();

      this.ready = true;
      if (window.ResizeObserver) {
        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(container);
      }
      this.setView('overview', true);
      return this;
    },

    buildLights() {
      this.hemi = new THREE.HemisphereLight(0xdcecff, 0x9b8f7d, 0.85);
      this.scene.add(this.hemi);
      this.ambient = new THREE.AmbientLight(0xffffff, 0.22);
      this.scene.add(this.ambient);

      this.sun = new THREE.DirectionalLight(0xfff3e0, 2.25);
      this.sun.position.set(4.8, 6.4, 4.2);
      this.sun.target.position.set(0, 1.0, -1.2);
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.camera.near = 0.5;
      this.sun.shadow.camera.far = 24;
      this.sun.shadow.camera.left = -5.5;
      this.sun.shadow.camera.right = 5.5;
      this.sun.shadow.camera.top = 5.5;
      this.sun.shadow.camera.bottom = -5.5;
      this.sun.shadow.bias = -0.00035;
      this.sun.shadow.normalBias = 0.018;
      this.scene.add(this.sun);
      this.scene.add(this.sun.target);

      const fill = new THREE.PointLight(0xd9ecff, 14, 10, 2);
      fill.position.set(-1.5, 2.9, -1.1);
      this.scene.add(fill);

      const fill2 = new THREE.PointLight(0xffe8c9, 8, 8, 2);
      fill2.position.set(2.4, 2.4, 1.8);
      this.scene.add(fill2);
    },

    hexToRgb(hex) {
      const h = String(hex || '#cbc7be').replace('#', '');
      const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    },

    makeFloorTexture(baseHex) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 512;
      const ctx = cv.getContext('2d');
      const base = this.hexToRgb(baseHex);
      ctx.fillStyle = baseHex || '#cbc7be';
      ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 9000; i++) {
        const d = Math.floor(Math.random() * 50) - 25;
        ctx.fillStyle = 'rgba(' + U.clamp(base.r + d, 0, 255) + ',' + U.clamp(base.g + d, 0, 255) + ',' +
          U.clamp(base.b + d, 0, 255) + ',' + (0.05 + Math.random() * 0.14) + ')';
        const r = Math.random() * 2.4 + 0.4;
        ctx.fillRect(Math.random() * 512, Math.random() * 512, r, r);
      }
      ctx.strokeStyle = 'rgba(70,78,88,.16)';
      ctx.lineWidth = 2;
      for (let i = 0; i <= 512; i += 128) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(Math.max(3.2, C.room.width / 2.6), Math.max(2.4, C.room.depth / 2.6));
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      return tex;
    },

    makeRibTexture(baseHex) {
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 256;
      const ctx = cv.getContext('2d');
      const base = this.hexToRgb(baseHex);
      ctx.fillStyle = baseHex || '#b9c3cd';
      ctx.fillRect(0, 0, 256, 256);
      for (let x = 0; x < 256; x += 26) {
        const g = ctx.createLinearGradient(x, 0, x + 26, 0);
        g.addColorStop(0, 'rgba(0,0,0,.16)');
        g.addColorStop(0.35, 'rgba(255,255,255,.14)');
        g.addColorStop(0.65, 'rgba(255,255,255,.05)');
        g.addColorStop(1, 'rgba(0,0,0,.18)');
        ctx.fillStyle = g;
        ctx.fillRect(x, 0, 22, 256);
      }
      ctx.strokeStyle = 'rgba(' + Math.max(0, base.r - 45) + ',' + Math.max(0, base.g - 45) + ',' + Math.max(0, base.b - 45) + ',.22)';
      ctx.lineWidth = 1;
      for (let y = 0; y <= 256; y += 64) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
      }
      const tex = new THREE.CanvasTexture(cv);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
      return tex;
    },
    buildRoom() {
      const R = C.room;
      const scene = C.getScene(this.currentScene);
      this.currentScene = scene.id;
      this.obstacles = [];
      this.wallMeshes = [];

      if (this.roomGroup) {
        this.scene.remove(this.roomGroup);
        this.roomGroup.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) {
            if (o.material.map) o.material.map.dispose();
            o.material.dispose();
          }
        });
      }
      const group = new THREE.Group();
      group.name = 'Room_' + scene.id;
      this.scene.add(group);
      this.roomGroup = group;

      const colors = scene.colors;
      this._palette = colors;
      this._bgLight = new THREE.Color(colors.wall).lerp(new THREE.Color(0xffffff), 0.58);
      const wallMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.wall), roughness: 0.94, metalness: 0.0 });
      const wallMat2 = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.wall2), roughness: 0.95 });
      if (scene.appearance === 'steel') {
        wallMat2.map = this.makeRibTexture(colors.wall2);
        wallMat2.map.repeat.set(Math.max(4, R.width * 1.5), 2);
        wallMat2.color.set(0xffffff);
      }
      const glassMat = new THREE.MeshPhysicalMaterial({
        color: 0xbfe2f5, roughness: 0.06, metalness: 0.05, transparent: true, opacity: 0.34,
        side: THREE.DoubleSide, depthWrite: false
      });
      this._wallMat = wallMat;
      this._wallMat2 = wallMat2;
      this._glassMat = glassMat;

      const floorMat = new THREE.MeshStandardMaterial({
        map: this.makeFloorTexture(colors.floor), color: 0xffffff, roughness: 0.88, metalness: 0.03
      });
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(R.width, R.depth), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      group.add(floor);
      this._floorMat = floorMat;

      const ceilingMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.ceiling), roughness: 0.96, side: THREE.DoubleSide });
      const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(R.width, R.depth), ceilingMat);
      ceiling.rotation.x = Math.PI / 2;
      ceiling.position.y = R.height;
      ceiling.receiveShadow = true;
      group.add(ceiling);
      this._ceilingMat = ceilingMat;

      const add = (geo, mat, x, y, z, cast, receive) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        if (cast !== false) m.castShadow = true;
        if (receive !== false) m.receiveShadow = true;
        group.add(m);
        return m;
      };
      const addObstacle = (name, x0, y0, z0, x1, y1, z1) => {
        this.obstacles.push({
          name: name,
          box: new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1))
        });
      };

      // 后墙（主喷涂面）
      const mainWall = add(new THREE.BoxGeometry(R.width, R.height, 0.1), wallMat, 0, R.height / 2, R.wallZ - 0.05);
      this.wallMeshes.push(mainWall);
      // 左墙
      const leftWall = add(new THREE.BoxGeometry(0.1, R.height, R.depth), wallMat2, -R.width / 2 - 0.05, R.height / 2, 0);
      this.wallMeshes.push(leftWall);

      const wx = R.width / 2 + 0.06;
      const win = R.window;
      if (win) {
        // 右墙（含窗洞）
        const zBackEdge = -R.depth / 2;
        const zFrontEdge = R.depth / 2;
        const z0 = win.z - win.w / 2;
        const z1 = win.z + win.w / 2;
        const y0 = win.sill;
        const y1 = win.sill + win.h;
        const addRight = (h, d, y, z) => {
          this.wallMeshes.push(add(new THREE.BoxGeometry(0.12, h, d), wallMat2, wx, y, z));
        };
        addRight(y0, R.depth, y0 / 2, 0);
        addRight(R.height - y1, R.depth, (R.height + y1) / 2, 0);
        addRight(y1 - y0, z0 - zBackEdge, (y0 + y1) / 2, (z0 + zBackEdge) / 2);
        addRight(y1 - y0, zFrontEdge - z1, (y0 + y1) / 2, (z1 + zFrontEdge) / 2);

        const glass = new THREE.Mesh(new THREE.PlaneGeometry(win.w, win.h), glassMat);
        glass.rotation.y = -Math.PI / 2;
        glass.position.set(wx - 0.065, y0 + win.h / 2, win.z);
        group.add(glass);

        const frameMat = new THREE.MeshStandardMaterial({ color: 0x4d5561, roughness: 0.42, metalness: 0.55 });
        const addBar = (h, d, y, z) => add(new THREE.BoxGeometry(0.08, h, d), frameMat, wx - 0.08, y, z);
        addBar(0.06, win.w + 0.1, y1 + 0.02, win.z);
        addBar(0.06, win.w + 0.1, y0 - 0.02, win.z);
        addBar(win.h, 0.06, y0 + win.h / 2, z0 - 0.02);
        addBar(win.h, 0.06, y0 + win.h / 2, z1 + 0.02);
        addBar(win.h, 0.045, y0 + win.h / 2, win.z);

        const sky = new THREE.Mesh(
          new THREE.PlaneGeometry(win.w + 1.1, win.h + 0.9),
          new THREE.MeshBasicMaterial({ map: this.makeSkyTexture() })
        );
        sky.rotation.y = -Math.PI / 2;
        sky.position.set(wx + 0.18, y0 + win.h / 2, win.z);
        group.add(sky);

        add(new THREE.BoxGeometry(0.24, 0.05, win.w + 0.16),
          new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.6 }), wx - 0.1, y0 - 0.06, win.z);
        addObstacle('窗框', wx - 0.2, y0 - 0.1, z0 - 0.1, wx + 0.15, y1 + 0.1, z1 + 0.1);
      } else {
        this.wallMeshes.push(add(new THREE.BoxGeometry(0.12, R.height, R.depth), wallMat2, wx, R.height / 2, 0));
      }

      const dz = R.depth / 2 + 0.06;
      const door = R.door;
      if (door) {
        const dx0 = door.x - door.w / 2, dx1 = door.x + door.w / 2;
        const addFront = (w, h, x, y) => {
          this.wallMeshes.push(add(new THREE.BoxGeometry(w, h, 0.12), wallMat2, x, y, dz));
        };
        addFront(dx0 + R.width / 2, R.height, (dx0 - R.width / 2) / 2, R.height / 2);
        addFront(R.width / 2 - dx1, R.height, (dx1 + R.width / 2) / 2, R.height / 2);
        addFront(door.w, R.height - door.h, door.x, (R.height + door.h) / 2);
        const doorMat = new THREE.MeshStandardMaterial({ color: 0x59616c, roughness: 0.62, metalness: 0.12 });
        add(new THREE.BoxGeometry(door.w - 0.1, door.h - 0.04, 0.05), doorMat, door.x, door.h / 2 - 0.02, dz - 0.09);
        add(new THREE.SphereGeometry(0.035, 16, 12),
          new THREE.MeshStandardMaterial({ color: 0xd8b45a, roughness: 0.3, metalness: 0.8 }),
          door.x - door.w / 2 + 0.17, 1.03, dz - 0.13);
      } else {
        this.wallMeshes.push(add(new THREE.BoxGeometry(R.width, R.height, 0.12), wallMat2, 0, R.height / 2, dz));
      }

      // 踢脚线
      const baseMat = new THREE.MeshStandardMaterial({ color: 0x7d838c, roughness: 0.65, metalness: 0.15 });
      add(new THREE.BoxGeometry(R.width, 0.09, 0.035), baseMat, 0, 0.045, R.wallZ + 0.02);
      add(new THREE.BoxGeometry(0.035, 0.09, R.depth), baseMat, -R.width / 2 + 0.02, 0.045, 0);
      add(new THREE.BoxGeometry(0.035, 0.09, R.depth), baseMat, R.width / 2 - 0.02, 0.045, 0);

      const p = R.pilaster;
      if (p) {
        add(new THREE.BoxGeometry(p.w, p.h, p.d), wallMat2, p.x, p.h / 2, p.z);
        addObstacle('结构立柱', p.x - p.w / 2, 0, p.z - p.d / 2, p.x + p.w / 2, p.h, p.z + p.d / 2);
      }

      const metal = new THREE.MeshStandardMaterial({ color: 0x8b96a3, roughness: 0.42, metalness: 0.55 });
      const darkMetal = new THREE.MeshStandardMaterial({ color: 0x46515f, roughness: 0.5, metalness: 0.45 });
      const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.accent), roughness: 0.55, metalness: 0.2 });
      const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3d6, emissiveIntensity: 1.5 });

      this.buildSceneProps(group, scene, { add, addObstacle, wallMat2, metal, darkMetal, accentMat, lampMat, wallMat });

      // 顶部灯具按场景布置
      if (scene.appearance === 'residence' || scene.appearance === 'electrical') {
        add(new THREE.BoxGeometry(R.width * 0.24, 0.05, 0.34), lampMat, -R.width * 0.1, R.height - 0.06, -R.depth * 0.15);
        add(new THREE.BoxGeometry(R.width * 0.24, 0.05, 0.34), lampMat, R.width * 0.18, R.height - 0.06, R.depth * 0.2);
      } else {
        for (let ix = 0; ix < 3; ix++) {
          for (let iz = 0; iz < 2; iz++) {
            const x = -R.width * 0.28 + ix * R.width * 0.28;
            const z = -R.depth * 0.2 + iz * R.depth * 0.35;
            add(new THREE.BoxGeometry(1.1, 0.05, 0.32), lampMat, x, R.height - 0.08, z, false, false);
          }
        }
      }

      this.buildMarkers(group);
      this.wallPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -R.wallZ);
    },

    buildSceneProps(group, scene, M) {
      const R = C.room;
      const add = M.add;
      const a = scene.appearance;

      if (a === 'residence') {
        return;
      }

      if (a === 'cleanroom') {
        const seam = new THREE.MeshStandardMaterial({ color: 0xc9d9e7, roughness: 0.65 });
        for (let i = 1; i < 8; i++) {
          const x = -R.width / 2 + (R.width / 8) * i;
          add(new THREE.BoxGeometry(0.016, R.height - 0.25, 0.012), seam, x, R.height / 2, R.wallZ + 0.012, false, false);
          add(new THREE.BoxGeometry(0.012, R.height - 0.25, 0.016), seam, -R.width / 2 + 0.012, R.height / 2, -R.depth / 2 + (R.depth / 7) * i, false, false);
        }
        add(new THREE.BoxGeometry(R.width, 0.014, 0.012), seam, 0, R.height * 0.62, R.wallZ + 0.012, false, false);
        // 洁净工作台
        add(new THREE.BoxGeometry(2.6, 0.85, 0.72), M.metal, -R.width / 2 + 1.7, 0.425, -R.depth * 0.22);
        add(new THREE.BoxGeometry(2.6, 0.06, 0.8), M.darkMetal, -R.width / 2 + 1.7, 0.88, -R.depth * 0.22);
        add(new THREE.BoxGeometry(2.2, 0.85, 0.72), M.metal, -R.width / 2 + 1.6, 0.425, R.depth * 0.22);
        add(new THREE.BoxGeometry(2.2, 0.06, 0.8), M.darkMetal, -R.width / 2 + 1.6, 0.88, R.depth * 0.22);
        M.addObstacle('洁净工作台A', -R.width / 2 + 0.4, 0, -R.depth * 0.22 - 0.4, -R.width / 2 + 3.0, 0.95, -R.depth * 0.22 + 0.4);
        M.addObstacle('洁净工作台B', -R.width / 2 + 0.5, 0, R.depth * 0.22 - 0.4, -R.width / 2 + 2.7, 0.95, R.depth * 0.22 + 0.4);
        // 送风管
        add(new THREE.BoxGeometry(R.width * 0.7, 0.34, 0.42), M.metal, 0, R.height - 0.3, R.wallZ + 0.6);
        // 地面导视线
        const lineMat = new THREE.MeshBasicMaterial({ color: 0x3b8fd6, transparent: true, opacity: 0.5 });
        const line = new THREE.Mesh(new THREE.PlaneGeometry(R.width * 0.8, 0.05), lineMat);
        line.rotation.x = -Math.PI / 2;
        line.position.set(0, 0.012, 1.2);
        group.add(line);
        return;
      }

      if (a === 'steel') {
        // 钢柱
        [[-R.width * 0.36, -R.depth * 0.32], [R.width * 0.36, -R.depth * 0.32],
         [-R.width * 0.36, R.depth * 0.28], [R.width * 0.36, R.depth * 0.28]].forEach((pos, i) => {
          add(new THREE.BoxGeometry(0.26, R.height, 0.26), M.darkMetal, pos[0], R.height / 2, pos[1]);
          M.addObstacle('钢柱' + (i + 1), pos[0] - 0.16, 0, pos[1] - 0.16, pos[0] + 0.16, R.height, pos[1] + 0.16);
        });
        // 屋面桁架
        for (let i = 0; i < 4; i++) {
          const z = -R.depth * 0.36 + i * R.depth * 0.24;
          add(new THREE.BoxGeometry(R.width, 0.12, 0.12), M.darkMetal, 0, R.height - 0.32, z, false, false);
        }
        // 工业吊灯
        for (let i = 0; i < 3; i++) {
          const x = -R.width * 0.25 + i * R.width * 0.25;
          add(new THREE.CylinderGeometry(0.03, 0.03, 0.5, 8), M.darkMetal, x, R.height - 0.55, -R.depth * 0.05, false, false);
          add(new THREE.ConeGeometry(0.28, 0.3, 14), M.lampMat, x, R.height - 0.78, -R.depth * 0.05, false, false);
        }
        // 沿墙管线
        const pipe = new THREE.CylinderGeometry(0.1, 0.1, R.depth * 0.75, 12);
        const p1 = add(pipe, M.metal, -R.width / 2 + 0.3, R.height * 0.66, 0);
        p1.rotation.x = Math.PI / 2;
        const p2 = add(new THREE.CylinderGeometry(0.07, 0.07, R.depth * 0.7, 10), M.accentMat, -R.width / 2 + 0.5, R.height * 0.55, 0);
        p2.rotation.x = Math.PI / 2;
        // 安全地标线
        const stripeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(scene.colors.accent), transparent: true, opacity: 0.45 });
        [-R.depth * 0.36, R.depth * 0.36].forEach((z) => {
          const s = new THREE.Mesh(new THREE.PlaneGeometry(R.width * 0.9, 0.06), stripeMat);
          s.rotation.x = -Math.PI / 2;
          s.position.set(0, 0.013, z);
          group.add(s);
        });
        return;
      }

      if (a === 'storage') {
        // 储罐
        const tankMat = new THREE.MeshStandardMaterial({ color: 0xd3d8dd, roughness: 0.34, metalness: 0.55 });
        const tanks = [
          { x: -R.width * 0.27, z: -R.depth * 0.2, r: 1.05, h: 2.45 },
          { x: R.width * 0.28, z: -R.depth * 0.28, r: 0.9, h: 2.2 }
        ];
        tanks.forEach((t, i) => {
          add(new THREE.CylinderGeometry(t.r, t.r, t.h, 28), tankMat, t.x, t.h / 2, t.z);
          add(new THREE.CylinderGeometry(t.r * 0.55, t.r, 0.22, 24), tankMat, t.x, t.h + 0.11, t.z);
          add(new THREE.CylinderGeometry(t.r * 0.9, t.r * 0.9, 0.06, 24), M.darkMetal, t.x, t.h + 0.24, t.z, false, false);
          M.addObstacle('储罐' + (i + 1), t.x - t.r * 0.92, 0, t.z - t.r * 0.92, t.x + t.r * 0.92, t.h, t.z + t.r * 0.92);
        });
        // 管线
        const pipeMat = new THREE.MeshStandardMaterial({ color: 0xb8b3aa, roughness: 0.4, metalness: 0.5 });
        const pipe = new THREE.CylinderGeometry(0.12, 0.12, R.width * 0.8, 12);
        const horizontal = add(pipe, pipeMat, 0, R.height - 0.5, R.wallZ + 0.45, false, false);
        horizontal.rotation.z = Math.PI / 2;
        // 防撞柱
        for (let i = 0; i < 5; i++) {
          const x = -R.width * 0.4 + i * R.width * 0.2;
          add(new THREE.CylinderGeometry(0.09, 0.09, 0.95, 12), M.accentMat, x, 0.475, R.depth * 0.34);
          M.addObstacle('防撞柱' + (i + 1), x - 0.12, 0, R.depth * 0.34 - 0.12, x + 0.12, 0.95, R.depth * 0.34 + 0.12);
        }
        // 地面警戒线
        const warnMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(scene.colors.accent), transparent: true, opacity: 0.42 });
        [-R.width * 0.07, R.width * 0.07].forEach((x) => {
          const s = new THREE.Mesh(new THREE.PlaneGeometry(0.07, R.depth * 0.72), warnMat);
          s.rotation.x = -Math.PI / 2;
          s.position.set(x, 0.013, 0);
          group.add(s);
        });
        return;
      }

      if (a === 'electrical') {
        // 配电柜
        const cabMat = new THREE.MeshStandardMaterial({ color: 0x5d6b7a, roughness: 0.55, metalness: 0.35 });
        const cabMat2 = new THREE.MeshStandardMaterial({ color: 0x8d99a6, roughness: 0.5, metalness: 0.3 });
        [-1, 1].forEach((side) => {
          for (let i = 0; i < 3; i++) {
            const z = -R.depth * 0.3 + i * R.depth * 0.3;
            const x = side * (R.width / 2 - 0.55);
            add(new THREE.BoxGeometry(0.85, 2.1, 0.9), i % 2 ? cabMat2 : cabMat, x, 1.05, z);
            add(new THREE.BoxGeometry(0.02, 1.9, 0.7), M.darkMetal, x - side * 0.44, 1.05, z, false, false);
            M.addObstacle('配电柜', x - 0.45, 0, z - 0.45, x + 0.45, 2.1, z + 0.45);
          }
        });
        // 电缆桥架
        [-R.depth * 0.15, R.depth * 0.15].forEach((z) => {
          add(new THREE.BoxGeometry(R.width * 0.9, 0.12, 0.3), M.metal, 0, R.height - 0.45, z, false, false);
        });
        // 地面警示线
        const warnMat = new THREE.MeshBasicMaterial({ color: 0xd7a400, transparent: true, opacity: 0.4 });
        [-R.width * 0.38, R.width * 0.38].forEach((x) => {
          const s = new THREE.Mesh(new THREE.PlaneGeometry(0.09, R.depth * 0.8), warnMat);
          s.rotation.x = -Math.PI / 2;
          s.position.set(x, 0.013, 0);
          group.add(s);
        });
      }
    },

    makeSkyTexture() {
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 256;
      const ctx = cv.getContext('2d');
      const g = ctx.createLinearGradient(0, 0, 0, 256);
      g.addColorStop(0, '#8fc8ee');
      g.addColorStop(0.6, '#d6ecfa');
      g.addColorStop(1, '#eef5f4');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 512, 256);
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      for (let i = 0; i < 7; i++) {
        const x = Math.random() * 512, y = 30 + Math.random() * 80, r = 20 + Math.random() * 35;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      const buildings = [
        [20, 90, 60, 140], [90, 120, 45, 110], [150, 75, 70, 155], [235, 110, 50, 120],
        [300, 95, 80, 135], [395, 125, 55, 105], [460, 85, 45, 145]
      ];
      buildings.forEach((b, i) => {
        ctx.fillStyle = i % 2 ? 'rgba(124,145,160,.62)' : 'rgba(137,156,170,.52)';
        ctx.fillRect(b[0], b[1], b[2], b[3]);
        ctx.fillStyle = 'rgba(255,255,255,.35)';
        for (let y = b[1] + 12; y < b[1] + b[3] - 10; y += 18) {
          for (let x = b[0] + 8; x < b[0] + b[2] - 8; x += 14) ctx.fillRect(x, y, 5, 7);
        }
      });
      const flag = ctx.createLinearGradient(0, 0, 512, 0);
      flag.addColorStop(0, 'rgba(255,255,255,.35)');
      flag.addColorStop(0.5, 'rgba(255,255,255,.05)');
      flag.addColorStop(1, 'rgba(255,255,255,.35)');
      ctx.fillStyle = flag;
      ctx.fillRect(0, 0, 512, 256);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    },
    buildMarkers(parent) {
      const host = parent || this.scene;
      const y = 0.012;
      const w = 1.7, d = 1.35;
      const cx = C.robot.position.x, cz = C.robot.position.z;
      const pts = [
        new THREE.Vector3(cx - w / 2, y, cz - d / 2),
        new THREE.Vector3(cx + w / 2, y, cz - d / 2),
        new THREE.Vector3(cx + w / 2, y, cz + d / 2),
        new THREE.Vector3(cx - w / 2, y, cz + d / 2),
        new THREE.Vector3(cx - w / 2, y, cz - d / 2)
      ];
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xf0b400, transparent: true, opacity: 0.75 }));
      host.add(line);

      const cornerMat = new THREE.MeshBasicMaterial({ color: 0xf0b400, transparent: true, opacity: 0.8 });
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([sx, sz]) => {
        for (let i = 0; i < 3; i++) {
          const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.035), cornerMat);
          strip.rotation.x = -Math.PI / 2;
          strip.position.set(cx + sx * (w / 2 - 0.1), y + 0.002, cz + sz * (d / 2 - 0.02 - i * 0.07));
          host.add(strip);
        }
      });

      const axisMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 });
      const crossGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(cx - 0.35, y + 0.002, cz), new THREE.Vector3(cx + 0.35, y + 0.002, cz),
        new THREE.Vector3(cx, y + 0.002, cz - 0.35), new THREE.Vector3(cx, y + 0.002, cz + 0.35)
      ]);
      host.add(new THREE.LineSegments(crossGeo, axisMat));
    },

    buildPlanningObjects() {
      const R = C.room;
      const selMat = new THREE.MeshBasicMaterial({
        color: 0xffcc00, transparent: true, opacity: 0.17, side: THREE.DoubleSide,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2
      });
      const sel = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), selMat);
      sel.position.set(0, 1.4, R.wallZ + 0.013);
      sel.visible = false;

      const border = new THREE.Line(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xffb800, transparent: true, opacity: 0.95 }));
      border.visible = false;

      this.selectionGroup = new THREE.Group();
      this.selectionGroup.add(sel);
      this.selectionGroup.add(border);
      this.selectionGroup.userData.mesh = sel;
      this.selectionGroup.userData.border = border;
      this.scene.add(this.selectionGroup);

      const path = new THREE.Line(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xffc107, transparent: true, opacity: 0.98 }));
      path.visible = false;
      const dots = new THREE.Points(new THREE.BufferGeometry(),
        new THREE.PointsMaterial({ color: 0xffc107, size: 0.035, sizeAttenuation: true, transparent: true, opacity: 0.95 }));
      dots.visible = false;

      this.pathGroup = new THREE.Group();
      this.pathGroup.add(path);
      this.pathGroup.add(dots);
      this.pathGroup.userData.line = path;
      this.pathGroup.userData.dots = dots;
      this.scene.add(this.pathGroup);
    },
    surfacePoint(surface, u, v, lift) {
      const R = C.room;
      const L = lift || 0;
      if (surface === 'ceiling') return new THREE.Vector3(u, R.height - L, v);
      if (surface === 'floor') return new THREE.Vector3(u, L, v);
      return new THREE.Vector3(u, v, R.wallZ + L);
    },

    surfaceNormal(surface) {
      if (surface === 'ceiling') return new THREE.Vector3(0, 1, 0);
      if (surface === 'floor') return new THREE.Vector3(0, -1, 0);
      return new THREE.Vector3(0, 0, -1);
    },

    setSelection(rect, surface) {
      if (!rect || !this.selectionGroup) return null;
      const R = C.room;
      const s = surface || this.surface || 'wall';
      const isWall = s === 'wall';
      const limU = (isWall ? R.wallWidth : R.width) / 2;
      const limV = isWall ? R.wallHeight : R.depth / 2;
      const vMin = isWall ? 0.08 : -limV + 0.05;
      const vMax = isWall ? R.wallHeight - 0.08 : limV - 0.05;
      const x0 = U.clamp(Math.min(rect.minX, rect.maxX), -limU + 0.05, limU - 0.05);
      const x1 = U.clamp(Math.max(rect.minX, rect.maxX), -limU + 0.05, limU - 0.05);
      const y0 = U.clamp(Math.min(rect.minY, rect.maxY), vMin, vMax);
      const y1 = U.clamp(Math.max(rect.minY, rect.maxY), vMin, vMax);
      if (x1 - x0 < 0.08 || y1 - y0 < 0.08) return null;
      const r = { surface: s, minX: x0, maxX: x1, minY: y0, maxY: y1 };
      this.selection = r;
      this.surface = s;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const mesh = this.selectionGroup.userData.mesh;
      if (s === 'wall') {
        mesh.rotation.set(0, 0, 0);
        mesh.position.set(cx, cy, R.wallZ + 0.013);
        mesh.scale.set(x1 - x0, y1 - y0, 1);
      } else if (s === 'ceiling') {
        mesh.rotation.set(Math.PI / 2, 0, 0);
        mesh.position.set(cx, R.height - 0.013, cy);
        mesh.scale.set(x1 - x0, y1 - y0, 1);
      } else {
        mesh.rotation.set(-Math.PI / 2, 0, 0);
        mesh.position.set(cx, 0.013, cy);
        mesh.scale.set(x1 - x0, y1 - y0, 1);
      }
      mesh.visible = true;
      const p0 = this.surfacePoint(s, x0, y0, 0.015);
      const p1 = this.surfacePoint(s, x1, y0, 0.015);
      const p2 = this.surfacePoint(s, x1, y1, 0.015);
      const p3 = this.surfacePoint(s, x0, y1, 0.015);
      const border = this.selectionGroup.userData.border;
      border.geometry.dispose();
      border.geometry = new THREE.BufferGeometry().setFromPoints([p0, p1, p2, p3, p0.clone()]);
      border.visible = true;
      return r;
    },

    showPath(plan) {
      if (!plan || !plan.length || !this.pathGroup) return;
      const surface = (plan[0] && plan[0].surface) || this.surface || 'wall';
      const pts = plan.map((p) => this.surfacePoint(p.surface || surface, p.u, p.v, 0.024));
      const path = this.pathGroup.userData.line;
      path.geometry.dispose();
      path.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      path.visible = true;
      const dots = this.pathGroup.userData.dots;
      dots.geometry.dispose();
      dots.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      dots.visible = true;
      this.pathPoints = plan;
    },

    clearPlanning(clearSelection) {
      if (this.pathGroup) {
        this.pathGroup.userData.line.visible = false;
        this.pathGroup.userData.dots.visible = false;
        this.pathPoints = null;
      }
      if (clearSelection && this.selectionGroup) {
        this.selectionGroup.userData.mesh.visible = false;
        this.selectionGroup.userData.border.visible = false;
        this.selection = null;
      }
    },

    raycastSurface(clientX, clientY, surface) {
      if (!this.renderer) return null;
      const rect = this.renderer.domElement.getBoundingClientRect();
      this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const s = surface || this.surface || 'wall';
      const R = C.room;
      let plane;
      if (s === 'ceiling') plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), R.height);
      else if (s === 'floor') plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      else plane = this.wallPlane;
      const point = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(plane, point)) return null;
      if (s === 'wall') {
        if (Math.abs(point.x) > R.wallWidth / 2 || point.y < 0 || point.y > R.wallHeight) return null;
        return { x: point.x, y: point.y, u: point.x, v: point.y, z: R.wallZ, surface: s, point };
      }
      if (Math.abs(point.x) > R.width / 2 || Math.abs(point.z) > R.depth / 2) return null;
      return { x: point.x, y: point.z, u: point.x, v: point.z, z: point.z, surface: s, point };
    },

    raycastWall(clientX, clientY) {
      return this.raycastSurface(clientX, clientY, 'wall');
    },

    checkBaseAt(x, z, margin) {
      const R = C.room;
      const m = margin == null ? 0.62 : margin;
      if (Math.abs(x) > R.width / 2 - m || Math.abs(z) > R.depth / 2 - m) return false;
      for (const ob of this.obstacles) {
        const b = ob.box;
        if (x > b.min.x - m && x < b.max.x + m && z > b.min.z - m && z < b.max.z + m) return false;
      }
      return true;
    },

    checkBaseRoute(from, to, margin) {
      const dist = Math.hypot(to.x - from.x, to.z - from.z);
      const n = Math.max(3, Math.ceil(dist / 0.25));
      for (let i = 0; i <= n; i++) {
        const k = i / n;
        const x = U.lerp(from.x, to.x, k);
        const z = U.lerp(from.z, to.z, k);
        if (!this.checkBaseAt(x, z, margin)) return false;
      }
      return true;
    },

    checkCollision(points, margin) {
      if (!points || !points.length) return { hit: false };
      const R = C.room;
      const m = margin == null ? 0.045 : margin;
      for (const p of points) {
        if (p.z <= R.wallZ + m) return { hit: true, reason: '主墙面', point: p };
        if (p.z >= R.depth / 2 - m) return { hit: true, reason: '前墙', point: p };
        if (Math.abs(p.x) >= R.width / 2 - m) return { hit: true, reason: '侧墙', point: p };
        if (p.y <= m) return { hit: true, reason: '地面', point: p };
        if (p.y >= R.height - m) return { hit: true, reason: '天花板', point: p };
        for (const ob of this.obstacles) {
          if (ob.box.clone().expandByScalar(m).containsPoint(p)) {
            return { hit: true, reason: ob.name, point: p };
          }
        }
      }
      return { hit: false };
    },
    setView(name, instant) {
      if (name !== 'follow' && this.follow) this.setFollow(false, true);
      const R = C.room;
      const presets = {
        overview: { pos: [R.width * 0.34, R.height * 0.95, R.depth * 0.34], target: [0, R.height * 0.35, -R.depth * 0.18] },
        arm: { pos: [R.width * 0.22, R.height * 0.72, R.depth * 0.28], target: [0, R.height * 0.45, -R.depth * 0.30] },
        wall: { pos: [R.width * 0.20, R.height * 0.60, R.depth * 0.30], target: [0, R.height * 0.55, R.wallZ] },
        ceiling: { pos: [R.width * 0.16, R.height * 0.55, R.depth * 0.30], target: [0, R.height * 0.9, -R.depth * 0.1] },
        floor: { pos: [R.width * 0.16, R.height * 0.85, R.depth * 0.30], target: [0, 0, -R.depth * 0.05] }
      };
      const p = presets[name] || presets.overview;
      this._view = name;
      SB.UI && SB.UI.setViewButton(name);
      if (instant) {
        this.camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
        this.controls.target.set(p.target[0], p.target[1], p.target[2]);
        this.controls.update();
        this.tween = null;
        return;
      }
      this.tween = {
        t: 0, duration: 0.85,
        fromPos: this.camera.position.clone(),
        toPos: new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]),
        fromTarget: this.controls.target.clone(),
        toTarget: new THREE.Vector3(p.target[0], p.target[1], p.target[2])
      };
    },

    setTheme(theme) {
      this.theme = theme === 'dark' ? 'dark' : 'light';
      const dark = this.theme === 'dark';
      const pal = this._palette || { wall: '#eeebe4', wall2: '#e6e2d9', ceiling: '#f2f0eb' };
      const bg = dark ? new THREE.Color(0x0f1726) : (this._bgLight || new THREE.Color(0xe9eef5));
      this.scene.background.copy(bg);
      this.scene.fog.color.copy(bg);
      if (this._wallMat) this._wallMat.color.set(dark ? 0x465266 : pal.wall);
      if (this._wallMat2) this._wallMat2.color.set(dark ? 0x3b4659 : (this.currentScene === 'steel' ? 0xffffff : pal.wall2));
      if (this._ceilingMat) this._ceilingMat.color.set(dark ? 0x263348 : pal.ceiling);
      if (this._floorMat) this._floorMat.color.set(dark ? 0x8b8e93 : 0xffffff);
      if (this.hemi) this.hemi.intensity = dark ? 0.55 : 0.85;
      if (this.ambient) this.ambient.intensity = dark ? 0.3 : 0.22;
      if (this.renderer) this.renderer.toneMappingExposure = dark ? 0.95 : 1.02;
      this.render();
    },

    setQuality(quality) {
      this.quality = quality || 'high';
      const high = this.quality === 'high';
      const low = this.quality === 'low';
      if (this.renderer) {
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, high ? 2 : low ? 1 : 1.5));
        this.renderer.shadowMap.enabled = !low;
      }
      if (this.sun) {
        this.sun.castShadow = !low;
        this.sun.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
        if (this.sun.shadow.map) {
          this.sun.shadow.map.dispose();
          this.sun.shadow.map = null;
        }
      }
      this.resize();
    },

    resize() {
      if (!this.renderer || !this.container) return;
      const w = Math.max(1, this.container.clientWidth);
      const h = Math.max(1, this.container.clientHeight);
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    },

    setFollow(on, silent) {
      const want = !!on;
      if (this.follow === want && silent !== 'init') return this.follow;
      this.follow = want;
      this._followLast = null;
      if (want) this.tween = null;
      if (this.controls) {
        this.controls.enablePan = !want;
        this.controls.dampingFactor = want ? 0.085 : 0.065;
      }
      const hint = document.querySelector('.canvas-hint');
      if (hint) hint.textContent = want ? '跟随中 · 左键旋转 · 滚轮缩放' : '左键旋转 · 右键平移 · 滚轮缩放';
      if (SB.UI && SB.UI.setFollow) SB.UI.setFollow(want);
      if (!silent && SB.UI) {
        SB.UI.log(want ? '视角跟随：已开启，相机随机器人移动' : '视角跟随：已关闭，自由漫游', 'info');
        SB.UI.toast(want ? '视角跟随已开启' : '视角跟随已关闭', want ? 'ok' : 'info');
      }
      return this.follow;
    },

    followRobot() {
      return this.setFollow(!this.follow);
    },

    update(dt) {
      if (this.tween) {
        this.tween.t += dt;
        const k = U.clamp(this.tween.t / this.tween.duration, 0, 1);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        this.camera.position.lerpVectors(this.tween.fromPos, this.tween.toPos, e);
        this.controls.target.lerpVectors(this.tween.fromTarget, this.tween.toTarget, e);
        if (k >= 1) this.tween = null;
      }
      // 跟随模式：相机与观察点随底盘平移，保留用户自由旋转 / 缩放
      if (this.follow && SB.App && SB.App.robot) {
        const base = SB.App.robot.getBasePose();
        if (!this._followLast) {
          this._followLast = { x: base.x, z: base.z };
        } else {
          const dx = base.x - this._followLast.x;
          const dz = base.z - this._followLast.z;
          if (Math.abs(dx) + Math.abs(dz) > 0.0005) {
            this.camera.position.x += dx;
            this.camera.position.z += dz;
            this.controls.target.x += dx;
            this.controls.target.z += dz;
            this._followLast.x = base.x;
            this._followLast.z = base.z;
          }
        }
      }
      this.controls.update();
    },

    render() {
      if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
    },

    dispose() {
      if (this._ro) this._ro.disconnect();
      if (this.renderer) {
        this.renderer.dispose();
        if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
  };
})();