/* =========================================================
 * robot.js — 程序化六轴喷涂机器人、解析 IK/FK、碰撞采样、GLB 替换
 * ========================================================= */
(function () {
  'use strict';
  const SB = window.SprayBot;
  const C = SB.CONFIG;
  const U = SB.U;
  const R = C.robot;

  function RobotRig(sceneMgr) {
    this.sceneMgr = sceneMgr;
    this.scene = sceneMgr.scene;
    this.root = new THREE.Group();
    this.root.name = 'SprayRobotRoot';
    this.basePos = new THREE.Vector3(R.position.x, 0, R.position.z);
    this.baseYaw = R.yawOffset;
    this.root.position.set(this.basePos.x, 0, this.basePos.z);
    this.root.rotation.y = this.baseYaw;
    sceneMgr.scene.add(this.root);

    this.armMeshes = [];
    this.chassisMeshes = [];
    this.nozzleMeshes = [];
    this.jointGroups = [];
    this.custom = null;
    this.currentJoints = [0, 0, 0, 0, 0, 0];
    this._hoseClock = 0;
    this._hoseLastEnd = null;
    this._layerState = { chassis: true, arm: true, nozzle: true, hose: true };
    this.liftY = (R.lift && R.lift.home) || 0;
    this.liftTarget = this.liftY;
    this.gripperOpen = 0.55;
    this.gripperTarget = 0.55;

    this.materials = {
      blue: new THREE.MeshStandardMaterial({ color: 0x0066cc, metalness: 0.42, roughness: 0.34 }),
      blueDark: new THREE.MeshStandardMaterial({ color: 0x0a4a88, metalness: 0.5, roughness: 0.32 }),
      blueLight: new THREE.MeshStandardMaterial({ color: 0x2b8ce6, metalness: 0.35, roughness: 0.38 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x28313d, metalness: 0.55, roughness: 0.42 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x98a4b3, metalness: 0.82, roughness: 0.28 }),
      yellow: new THREE.MeshStandardMaterial({ color: 0xffcc00, metalness: 0.25, roughness: 0.42 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x171b22, metalness: 0.05, roughness: 0.92 }),
      white: new THREE.MeshStandardMaterial({ color: 0xe9eef4, metalness: 0.15, roughness: 0.5 }),
      bodyBlue: new THREE.MeshStandardMaterial({ color: 0x3d9fdd, metalness: 0.28, roughness: 0.42 }),
      bodyBlueDark: new THREE.MeshStandardMaterial({ color: 0x1f7cb8, metalness: 0.34, roughness: 0.40 }),
      silver: new THREE.MeshStandardMaterial({ color: 0xd9e0e8, metalness: 0.45, roughness: 0.36 }),
      violet: new THREE.MeshStandardMaterial({ color: 0x8b7bd6, metalness: 0.35, roughness: 0.38 }),
      red: new THREE.MeshStandardMaterial({ color: 0xd23c2f, metalness: 0.2, roughness: 0.55 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xcbe7f7, metalness: 0.1, roughness: 0.08, transparent: true, opacity: 0.42 }),
      led: new THREE.MeshStandardMaterial({ color: 0x22d37a, emissive: 0x22d37a, emissiveIntensity: 2.0 }),
      orange: new THREE.MeshStandardMaterial({ color: 0xff8a1e, metalness: 0.2, roughness: 0.45 }),
      amber: new THREE.MeshStandardMaterial({ color: 0xffa31a, emissive: 0xff8a00, emissiveIntensity: 0.85, roughness: 0.32 }),
      laser: new THREE.MeshStandardMaterial({ color: 0xff2b2b, emissive: 0xff2b2b, emissiveIntensity: 2.2 }),
      agvBlue: new THREE.MeshStandardMaterial({ color: 0x1a70c8, metalness: 0.10, roughness: 0.52 }),
      agvBlueDark: new THREE.MeshStandardMaterial({ color: 0x11538f, metalness: 0.12, roughness: 0.50 }),
      fabric: new THREE.MeshStandardMaterial({ color: 0x2a7ac8, metalness: 0.03, roughness: 0.92 }),
      fabricDark: new THREE.MeshStandardMaterial({ color: 0x1d5c99, metalness: 0.03, roughness: 0.94 })
    };

    const noise = this.makeSurfaceNoise();
    [['steel', 0.0025], ['silver', 0.0018], ['white', 0.0016], ['bodyBlue', 0.0014], ['bodyBlueDark', 0.0014], ['rubber', 0.003], ['agvBlue', 0.0012], ['agvBlueDark', 0.0012]].forEach(([key, scale]) => {
      const m = this.materials[key];
      if (!m) return;
      m.bumpMap = noise;
      m.bumpScale = scale;
      m.needsUpdate = true;
    });
    const fabricNoise = this.makeFabricTexture();
    ['fabric', 'fabricDark'].forEach((key) => {
      const m = this.materials[key];
      if (!m) return;
      m.bumpMap = fabricNoise;
      m.bumpScale = 0.005;
      m.needsUpdate = true;
    });
    this.buildChassis();
    this.buildLift();
    this.buildArm();
    this.buildHose();
    this.setJoints(this.computeHomeJoints());
  }

  RobotRig.prototype.addMesh = function (parent, geo, mat, layer, pos, rot) {
    const m = new THREE.Mesh(geo, mat);
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.layer = layer || 'arm';
    parent.add(m);
    if (m.userData.layer === 'chassis') this.chassisMeshes.push(m);
    else if (m.userData.layer === 'nozzle') this.nozzleMeshes.push(m);
    else if (m.userData.layer === 'arm') this.armMeshes.push(m);
    return m;
  };

  RobotRig.prototype.labelTexture = function (text, sub) {
    const cv = document.createElement('canvas');
    cv.width = 512; cv.height = 128;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0b4f8f';
    ctx.fillRect(0, 0, 512, 128);
    const g = ctx.createLinearGradient(0, 0, 512, 0);
    g.addColorStop(0, 'rgba(255,255,255,.18)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,.12)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 55px "Segoe UI", Arial';
    ctx.textAlign = 'center';
    ctx.fillText(text, 256, 66);
    if (sub) {
      ctx.fillStyle = '#ffcc00';
      ctx.font = '600 22px "Microsoft YaHei", Arial';
      ctx.fillText(sub, 256, 101);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  RobotRig.prototype.makeSurfaceNoise = function () {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 150 + Math.floor(Math.random() * 95);
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    return tex;
  };

  RobotRig.prototype.makeWarningTexture = function () {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f2c200';
    ctx.fillRect(0, 0, 256, 64);
    ctx.strokeStyle = '#1b1f26';
    ctx.lineWidth = 16;
    for (let x = -64; x < 320; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 64); ctx.lineTo(x + 64, 0);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  RobotRig.prototype.makeScreenTexture = function () {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 160;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#081521';
    ctx.fillRect(0, 0, 256, 160);
    const g = ctx.createLinearGradient(0, 0, 0, 54);
    g.addColorStop(0, '#0d6fb5');
    g.addColorStop(1, '#084a7d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 54);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px "Microsoft YaHei", Arial';
    ctx.fillText('QZ-1', 14, 34);
    ctx.fillStyle = '#bfe2ff';
    ctx.font = '13px "Microsoft YaHei", Arial';
    ctx.fillText('功能性涂层施工机器人', 14, 50);
    const rows = [['运行状态', '正常'], ['系统压力', '0.42 MPa'], ['涂料余量', '86 %'], ['作业模式', '自动']];
    ctx.font = '14px "Microsoft YaHei", Arial';
    rows.forEach((row, i) => {
      const y = 82 + i * 20;
      ctx.fillStyle = '#9fb4c6';
      ctx.fillText(row[0], 16, y);
      ctx.fillStyle = i === 0 ? '#3ade8a' : '#e8f1f8';
      ctx.textAlign = 'right';
      ctx.fillText(row[1], 200, y);
      ctx.textAlign = 'left';
    });
    ctx.fillStyle = '#3ade8a';
    ctx.beginPath(); ctx.arc(222, 30, 7, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1b3b52';
    ctx.lineWidth = 1;
    for (let y = 0; y < 160; y += 8) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(256, y); ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  RobotRig.prototype.makeEstopTexture = function () {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 34;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f2c200';
    ctx.fillRect(0, 0, 128, 34);
    ctx.strokeStyle = '#161a20';
    ctx.lineWidth = 3;
    ctx.strokeRect(2, 2, 124, 30);
    ctx.fillStyle = '#161a20';
    ctx.font = 'bold 16px "Microsoft YaHei", Arial';
    ctx.textAlign = 'center';
    ctx.fillText('急停 E-STOP', 64, 23);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  RobotRig.prototype.buildChassis = function () {
    const M = this.materials;
    this.chassisGroup = new THREE.Group();
    this.chassisGroup.name = 'Chassis';
    this.root.add(this.chassisGroup);

    // 立式钣金壳体：0.65m 宽、1.02m 长，边角 R15 圆角，上下两层结构
    const W = 0.65, L = 1.02, B0 = 0.17, B1 = 0.72;
    const roundedBody = (w, l, h, r) => {
      const s = new THREE.Shape();
      const hw = w / 2, hl = l / 2;
      s.moveTo(-hw + r, -hl);
      s.lineTo(hw - r, -hl);
      s.quadraticCurveTo(hw, -hl, hw, -hl + r);
      s.lineTo(hw, hl - r);
      s.quadraticCurveTo(hw, hl, hw - r, hl);
      s.lineTo(-hw + r, hl);
      s.quadraticCurveTo(-hw, hl, -hw, hl - r);
      s.lineTo(-hw, -hl + r);
      s.quadraticCurveTo(-hw, -hl, -hw + r, -hl);
      const g = new THREE.ExtrudeGeometry(s, {
        depth: h, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 2, curveSegments: 8
      });
      g.rotateX(-Math.PI / 2);
      return g;
    };

    const shell = this.addMesh(this.chassisGroup, roundedBody(W, L, B1 - B0 - 0.055, 0.018), M.agvBlue, 'chassis', [0, B0 + 0.03, 0]);
    shell.castShadow = true;
    // 下层行走动力舱裙边 + 2mm 拼接缝
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(W + 0.008, 0.055, L + 0.008), M.agvBlueDark, 'chassis', [0, B0 + 0.025, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(W + 0.004, 0.006, L + 0.004), M.dark, 'chassis', [0, B1 - 0.034, 0]);
    // 上层银灰安装平台，边缘外凸 5mm
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(W + 0.05, 0.038, L + 0.05), M.steel, 'chassis', [0, B1 - 0.005, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(W + 0.056, 0.012, L + 0.056), M.silver, 'chassis', [0, B1 + 0.018, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(W - 0.02, 0.014, L - 0.02), M.bodyBlueDark, 'chassis', [0, B1 + 0.029, 0]);

    // 驱动轮：大尺寸橡胶胎 + 横向防滑花纹 + 工程塑料轮毂
    this.driveWheels = [];
    this.casters = [];
    [-1, 1].forEach((s) => {
      const spin = new THREE.Group();
      spin.position.set(s * 0.35, 0.19, -0.06);
      this.chassisGroup.add(spin);
      this.addMesh(spin, new THREE.CylinderGeometry(0.19, 0.19, 0.15, 30), M.rubber, 'chassis', [0, 0, 0], [0, 0, Math.PI / 2]);
      for (let i = 0; i < 16; i++) {
        const a = i / 16 * Math.PI * 2;
        this.addMesh(spin, new THREE.BoxGeometry(0.158, 0.022, 0.036), M.dark, 'chassis',
          [0, Math.cos(a) * 0.181, Math.sin(a) * 0.181], [a, 0, 0]);
      }
      this.addMesh(spin, new THREE.CylinderGeometry(0.108, 0.108, 0.166, 24), M.dark, 'chassis', [0, 0, 0], [0, 0, Math.PI / 2]);
      this.addMesh(spin, new THREE.CylinderGeometry(0.068, 0.068, 0.186, 20), M.steel, 'chassis', [0, 0, 0], [0, 0, Math.PI / 2]);
      this.addMesh(spin, new THREE.CylinderGeometry(0.032, 0.032, 0.20, 16), M.silver, 'chassis', [0, 0, 0], [0, 0, Math.PI / 2]);
      for (let i = 0; i < 5; i++) {
        const a = i / 5 * Math.PI * 2 + 0.3;
        this.addMesh(spin, new THREE.CylinderGeometry(0.012, 0.012, 0.014, 8), M.dark, 'chassis',
          [s * 0.085, Math.cos(a) * 0.062, Math.sin(a) * 0.062], [0, 0, Math.PI / 2]);
      }
      this.addMesh(spin, new THREE.CylinderGeometry(0.012, 0.012, 0.02, 8), M.yellow, 'chassis',
        [s * 0.075, 0.112, -0.062], [0, 0, Math.PI / 2]);
      this.driveWheels.push({ spin: spin, x: s * 0.35, radius: 0.19 });
      // 轮罩与减震支座
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.035, 0.26, 0.18), M.agvBlueDark, 'chassis', [s * 0.295, 0.20, -0.06]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.026, 0.05, 0.10), M.steel, 'chassis', [s * 0.315, 0.34, -0.06]);
    });

    // 四角红色聚氨酯万向轮（双轮并排，可 360° 转向）
    [[-0.255, 0.43], [0.255, 0.43], [-0.255, -0.43], [0.255, -0.43]].forEach(([x, z]) => {
      const steer = new THREE.Group();
      steer.position.set(x, 0, z);
      this.chassisGroup.add(steer);
      const spin = new THREE.Group();
      spin.position.y = 0.072;
      steer.add(spin);
      [-1, 1].forEach((ss) => {
        this.addMesh(spin, new THREE.CylinderGeometry(0.072, 0.072, 0.048, 20), M.red, 'chassis', [ss * 0.031, 0, 0], [0, 0, Math.PI / 2]);
        this.addMesh(spin, new THREE.CylinderGeometry(0.034, 0.034, 0.052, 14), M.dark, 'chassis', [ss * 0.031, 0, 0], [0, 0, Math.PI / 2]);
      });
      this.addMesh(spin, new THREE.CylinderGeometry(0.016, 0.016, 0.085, 10), M.steel, 'chassis', [0, 0, 0], [0, 0, Math.PI / 2]);
      this.addMesh(steer, new THREE.BoxGeometry(0.10, 0.026, 0.062), M.dark, 'chassis', [0, 0.148, 0]);
      [-1, 1].forEach((ss) => {
        this.addMesh(steer, new THREE.BoxGeometry(0.012, 0.085, 0.068), M.dark, 'chassis', [ss * 0.050, 0.105, 0]);
      });
      this.addMesh(steer, new THREE.CylinderGeometry(0.038, 0.038, 0.03, 14), M.steel, 'chassis', [0, 0.168, 0]);
      this.casters.push({ steer: steer, spin: spin, x: x, z: z, radius: 0.072, angle: 0 });
    });

    // 正面特征：内嵌方形避障传感器 + 检修门与锁扣
    const fz = L / 2 + 0.004;
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.086, 0.086, 0.012), M.dark, 'chassis', [s * 0.145, 0.30, fz]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.072, 0.072, 0.014), M.silver, 'chassis', [s * 0.145, 0.30, fz + 0.004]);
      this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.021, 0.021, 0.008, 14), M.blueDark, 'chassis', [s * 0.145, 0.30, fz + 0.012], [Math.PI / 2, 0, 0]);
    });
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.40, 0.30, 0.010), M.agvBlueDark, 'chassis', [0, 0.46, fz - 0.002]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.37, 0.27, 0.014), M.agvBlue, 'chassis', [0, 0.46, fz + 0.004]);
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.014, 0.075, 0.018), M.silver, 'chassis', [s * 0.105, 0.46, fz + 0.016]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.024, 0.030, 0.012), M.dark, 'chassis', [s * 0.105, 0.435, fz + 0.026]);
    });
    // 7 条斜向警示条纹（深蓝，左下方倾斜）
    for (let i = 0; i < 7; i++) {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.006, 0.102, 0.020), M.agvBlueDark, 'chassis',
        [-W / 2 - 0.004, 0.30, -0.20 + i * 0.046], [Math.PI / 4, 0, 0]);
    }

    // 双侧检修板、接缝与内六角螺栓
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.008, 0.30, 0.62), M.agvBlueDark, 'chassis', [s * (W / 2) , 0.44, 0.02]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.006, 0.006, 0.70), M.dark, 'chassis', [s * (W / 2 + 0.002), 0.36, 0.0]);
      [-0.22, 0.20].forEach((z) => {
        this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.007, 0.007, 0.006, 8), M.dark, 'chassis',
          [s * (W / 2 + 0.006), 0.30, z], [0, 0, Math.PI / 2]);
      });
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.006, 0.024, 0.96), M.yellow, 'chassis', [s * (W / 2 + 0.006), 0.20, 0]);
    });

    // 上层平台：内嵌黑色拉手、固定立柱的内六角螺丝孔
    [-0.24, 0.24].forEach((x) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.15, 0.012, 0.052), M.dark, 'chassis', [x, B1 + 0.020, 0.34]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.13, 0.014, 0.022), M.rubber, 'chassis', [x, B1 + 0.024, 0.34]);
    });
    [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => {
      this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.013, 0.013, 0.008, 6), M.dark, 'chassis',
        [sx * 0.18, B1 + 0.022, -0.12 + sz * 0.11]);
    }));

    // 后部：检修门、锁扣、HMI 屏与急停、状态灯
    const rz = -L / 2 - 0.004;
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.46, 0.34, 0.010), M.agvBlueDark, 'chassis', [0.06, 0.46, rz]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.43, 0.31, 0.014), M.agvBlue, 'chassis', [0.06, 0.46, rz - 0.004]);
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.014, 0.075, 0.018), M.silver, 'chassis', [0.06 + s * 0.115, 0.46, rz - 0.014]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.024, 0.030, 0.012), M.dark, 'chassis', [0.06 + s * 0.115, 0.435, rz - 0.024]);
    });
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.30, 0.19, 0.024), M.dark, 'chassis', [-0.17, 0.58, rz - 0.010]);
    const screenMat = new THREE.MeshBasicMaterial({ map: this.makeScreenTexture() });
    this.addMesh(this.chassisGroup, new THREE.PlaneGeometry(0.27, 0.165), screenMat, 'chassis', [-0.17, 0.58, rz - 0.024], [0, Math.PI, 0]);
    [-0.045, 0, 0.045].forEach((dx, i) => {
      this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.010, 0.010, 0.010, 10), [M.led, M.amber, M.red][i], 'chassis',
        [-0.17 + dx, 0.44, rz - 0.018], [Math.PI / 2, 0, 0]);
    });
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.055, 0.055, 0.016, 20), M.yellow, 'chassis', [0.17, 0.60, rz - 0.014], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.044, 0.044, 0.032, 20), M.dark, 'chassis', [0.17, 0.60, rz - 0.032], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.SphereGeometry(0.044, 18, 10), M.red, 'chassis', [0.17, 0.60, rz - 0.048]);
    const estopMat = new THREE.MeshBasicMaterial({ map: this.makeEstopTexture() });
    this.addMesh(this.chassisGroup, new THREE.PlaneGeometry(0.14, 0.038), estopMat, 'chassis', [0.17, 0.515, rz - 0.010], [0, Math.PI, 0]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.018, 0.018, 0.016, 14), M.steel, 'chassis', [-0.30, 0.50, rz - 0.012], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.014, 0.014, 0.018, 14), M.led, 'chassis', [-0.30, 0.50, rz - 0.026], [Math.PI / 2, 0, 0]);
    const warnMat = new THREE.MeshStandardMaterial({ map: this.makeWarningTexture(), roughness: 0.55, metalness: 0.05 });
    this.addMesh(this.chassisGroup, new THREE.PlaneGeometry(0.38, 0.075), warnMat, 'chassis', [0, 0.20, rz - 0.006], [0, Math.PI, 0]);
    // 后部盘绕电缆与红色快插接头
    this.addMesh(this.chassisGroup, new THREE.TorusGeometry(0.065, 0.011, 6, 18), M.rubber, 'chassis', [0.14, 0.25, rz - 0.02]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.024, 0.024, 0.05, 14), M.steel, 'chassis', [0.24, 0.20, rz - 0.02], [Math.PI / 2, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.030, 0.030, 0.012, 14), M.red, 'chassis', [0.24, 0.18, rz - 0.02], [Math.PI / 2, 0, 0]);

    // 四角橡胶防撞块
    [[-0.31, 0.47], [0.31, 0.47], [-0.31, -0.47], [0.31, -0.47]].forEach(([x, z]) => {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.022, 0.14, 0.05), M.rubber, 'chassis', [x, 0.28, z]);
    });
    // 铭牌
    const brandMat = new THREE.MeshStandardMaterial({ map: this.labelTexture('QZ-1', 'FUNCTIONAL COATING ROBOT'), roughness: 0.55, metalness: 0.12 });
    [-1, 1].forEach((s) => {
      this.addMesh(this.chassisGroup, new THREE.PlaneGeometry(0.30, 0.075), brandMat, 'chassis', [s * (W / 2 + 0.008), 0.56, -0.12], [0, s * Math.PI / 2, 0]);
    });

    // 立柱侧出管口（输料管起点）
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.028, 0.028, 0.045, 16), M.steel, 'chassis', [0.30, 1.06, -0.10], [0, 0, Math.PI / 2]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.015, 0.015, 0.018, 12), M.dark, 'chassis', [0.324, 1.06, -0.10], [0, 0, Math.PI / 2]);
  };

  // 垂直升降立柱：封闭蓝色柱体 + 双导轨 + 滑台 + 拖链
  RobotRig.prototype.buildLift = function () {
    const M = this.materials;
    const W = 0.52, D = 0.32, cz = -0.12;
    const colBottom = 0.775, colTop = 1.90;
    const colH = colTop - colBottom;
    this.liftGroup = new THREE.Group();
    this.liftGroup.name = 'LiftColumn';
    this.root.add(this.liftGroup);

    this.addMesh(this.liftGroup, new THREE.BoxGeometry(0.52, 0.05, 0.36), M.steel, 'chassis', [0, colBottom + 0.02, cz]);
    this.addMesh(this.liftGroup, new THREE.BoxGeometry(W, colH, D), M.agvBlue, 'chassis', [0, (colBottom + colTop) / 2, cz]);
    // 侧面围板与拼接缝
    [-1, 1].forEach((s) => {
      this.addMesh(this.liftGroup, new THREE.BoxGeometry(0.006, colH - 0.06, D - 0.02), M.agvBlueDark, 'chassis', [s * (W / 2 + 0.003), (colBottom + colTop) / 2, cz]);
      this.addMesh(this.liftGroup, new THREE.BoxGeometry(0.006, 0.006, D - 0.04), M.dark, 'chassis', [s * (W / 2 + 0.006), 1.02, cz]);
    });
    // 顶部封板与螺丝
    this.addMesh(this.liftGroup, new THREE.BoxGeometry(W + 0.02, 0.034, D + 0.02), M.agvBlue, 'chassis', [0, colTop + 0.006, cz]);
    this.addMesh(this.liftGroup, new THREE.BoxGeometry(W + 0.03, 0.010, D + 0.03), M.steel, 'chassis', [0, colTop + 0.026, cz]);
    [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => {
      this.addMesh(this.liftGroup, new THREE.CylinderGeometry(0.010, 0.010, 0.008, 6), M.dark, 'chassis',
        [sx * 0.24, colTop + 0.032, cz + sz * 0.12]);
    }));
    // 警示标签（CAUTION）
    const cautionMat = new THREE.MeshStandardMaterial({ map: this.makeCautionTexture(), roughness: 0.42, metalness: 0.05 });
    this.addMesh(this.liftGroup, new THREE.PlaneGeometry(0.16, 0.22), cautionMat, 'chassis',
      [0.05, 1.54, cz - D / 2 - 0.004], [0, Math.PI, 0]);

    // 正面双导轨（铝合金拉丝）
    const railZ = cz + D / 2 + 0.012;
    [-1, 1].forEach((s) => {
      this.addMesh(this.liftGroup, new THREE.BoxGeometry(0.048, 1.00, 0.052), M.steel, 'chassis', [s * 0.140, 1.32, railZ]);
      this.addMesh(this.liftGroup, new THREE.BoxGeometry(0.030, 0.98, 0.058), M.silver, 'chassis', [s * 0.140, 1.32, railZ + 0.006]);
      for (let i = 0; i < 10; i++) {
        this.addMesh(this.liftGroup, new THREE.CylinderGeometry(0.006, 0.006, 0.008, 6), M.dark, 'chassis',
          [s * 0.140, 0.88 + i * 0.098, railZ + 0.034], [Math.PI / 2, 0, 0]);
      }
    });

    // 升降滑台（L 型托架 + 加强筋 + 黑色滑块）
    this.liftCarriage = new THREE.Group();
    this.liftCarriage.name = 'LiftCarriage';
    this.liftCarriage.position.set(0, R.baseY + this.liftY, 0);
    this.root.add(this.liftCarriage);
    this.addMesh(this.liftCarriage, new THREE.BoxGeometry(0.44, 0.30, 0.028), M.steel, 'chassis', [0, -0.01, 0.115]);
    this.addMesh(this.liftCarriage, new THREE.BoxGeometry(0.36, 0.032, 0.34), M.steel, 'chassis', [0, -0.165, 0.26]);
    this.addMesh(this.liftCarriage, new THREE.BoxGeometry(0.34, 0.010, 0.32), M.silver, 'chassis', [0, -0.147, 0.26]);
    [-1, 1].forEach((s) => {
      this.addMesh(this.liftCarriage, new THREE.BoxGeometry(0.022, 0.115, 0.20), M.steel, 'chassis', [s * 0.145, -0.095, 0.18], [Math.PI / 4, 0, 0]);
      this.addMesh(this.liftCarriage, new THREE.BoxGeometry(0.075, 0.13, 0.05), M.dark, 'chassis', [s * 0.140, -0.02, 0.098]);
      [-1, 1].forEach((sy) => {
        this.addMesh(this.liftCarriage, new THREE.CylinderGeometry(0.008, 0.008, 0.01, 6), M.dark, 'chassis',
          [s * 0.140, -0.02 + sy * 0.06, 0.126], [Math.PI / 2, 0, 0]);
      });
      this.addMesh(this.liftCarriage, new THREE.CylinderGeometry(0.007, 0.007, 0.012, 6), M.dark, 'chassis', [s * 0.16, -0.165, 0.10]);
    });
    this.addMesh(this.liftCarriage, new THREE.BoxGeometry(0.40, 0.02, 0.028), M.agvBlue, 'chassis', [0, 0.142, 0.115]);

    // 拖链：分段铰接，随滑台高度自然弯曲
    this.chainLinks = [];
    const chainMat = M.rubber;
    for (let i = 0; i < 26; i++) {
      const link = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.036, 0.030), chainMat);
      link.castShadow = true;
      link.userData.layer = 'chassis';
      this.liftGroup.add(link);
      this.chassisMeshes.push(link);
      this.chainLinks.push(link);
    }
    this.updateChain();
  };

  RobotRig.prototype.makeCautionTexture = function () {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 360;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f2c200';
    ctx.fillRect(0, 0, 256, 150);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 150, 256, 210);
    ctx.strokeStyle = '#15191f';
    ctx.lineWidth = 6;
    ctx.strokeRect(4, 4, 248, 352);
    ctx.fillStyle = '#15191f';
    ctx.font = 'bold 46px "Segoe UI", Arial';
    ctx.textAlign = 'center';
    ctx.fillText('CAUTION', 128, 62);
    ctx.font = '600 22px "Microsoft YaHei", Arial';
    ctx.fillText('注意 安全操作', 128, 108);
    // 三角感叹号
    ctx.beginPath();
    ctx.moveTo(128, 178);
    ctx.lineTo(178, 258);
    ctx.lineTo(78, 258);
    ctx.closePath();
    ctx.fillStyle = '#f2c200';
    ctx.fill();
    ctx.strokeStyle = '#15191f';
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.fillStyle = '#15191f';
    ctx.font = 'bold 52px Arial';
    ctx.fillText('!', 128, 250);
    ctx.font = '16px "Microsoft YaHei", Arial';
    ctx.textAlign = 'left';
    ['1. 升降作业时禁止进入滑台行程范围', '2. 检修前断开电源并挂牌上锁', '3. 机械臂动作区域内请勿停留'].forEach((t, i) => {
      ctx.fillText(t, 22, 298 + i * 22);
    });
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };

  RobotRig.prototype.makeFabricTexture = function () {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 128;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 3) {
      ctx.fillStyle = 'rgba(40,40,40,.35)';
      ctx.fillRect(0, y, 128, 1);
    }
    for (let x = 0; x < 128; x += 3) {
      ctx.fillStyle = 'rgba(210,210,210,.22)';
      ctx.fillRect(x, 0, 1, 128);
    }
    for (let i = 0; i < 900; i++) {
      const g = 100 + Math.floor(Math.random() * 70);
      ctx.fillStyle = 'rgba(' + g + ',' + g + ',' + g + ',.25)';
      ctx.fillRect(Math.random() * 128, Math.random() * 128, 1, 1);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    return tex;
  };

  // 6 自由度协作臂：整臂蓝色防尘布罩 + 束带 + 管线束，末端平行夹爪
  RobotRig.prototype.buildArm = function () {
    const M = this.materials;
    const L1 = R.L1, L2 = R.L2;
    this.armBase = this.liftCarriage;
    const armZ = R.armOffsetZ || 0.30;

    const j1 = new THREE.Group();
    j1.name = 'J1';
    j1.position.set(0, 0, armZ);
    this.liftCarriage.add(j1);
    // J1 布罩收口 + 松紧带
    this.addMesh(j1, new THREE.CylinderGeometry(0.235, 0.25, 0.14, 26), M.fabric, 'arm', [0, 0.07, 0]);
    this.addMesh(j1, new THREE.CylinderGeometry(0.245, 0.245, 0.028, 26), M.dark, 'arm', [0, 0.014, 0]);
    this.addMesh(j1, new THREE.SphereGeometry(0.20, 22, 14), M.fabric, 'arm', [0, 0.225, 0]);
    this.addMesh(j1, new THREE.TorusGeometry(0.19, 0.016, 8, 24), M.fabricDark, 'arm', [0, 0.18, 0], [Math.PI / 2, 0, 0]);
    this.addMesh(j1, new THREE.BoxGeometry(0.20, 0.03, 0.02), M.dark, 'arm', [0.10, 0.28, 0.16]);

    const j2 = new THREE.Group();
    j2.name = 'J2';
    j2.position.set(0, R.shoulderY, 0);
    j1.add(j2);
    // 肩部布罩堆叠
    const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.205, 24, 16), M.fabric);
    shoulder.scale.set(0.95, 0.92, 1.06);
    shoulder.castShadow = shoulder.receiveShadow = true;
    shoulder.userData.layer = 'arm';
    j2.add(shoulder);
    this.armMeshes.push(shoulder);
    [-0.13, 0, 0.13].forEach((z, i) => {
      this.addMesh(j2, new THREE.TorusGeometry(0.185 - i * 0.006, 0.017, 8, 26), M.fabricDark, 'arm', [0, 0, z], [0, Math.PI / 2, 0]);
    });

    // 大臂：布罩圆管，两端收口、褶皱环与第一道束带
    const upLen = L1 - 0.09;
    this.addMesh(j2, new THREE.CylinderGeometry(0.128, 0.118, upLen, 22), M.fabric, 'arm', [0, 0, 0.045 + upLen / 2], [Math.PI / 2, 0, 0]);
    [0.16, 0.30, 0.46, 0.62, 0.78].forEach((z, i) => {
      this.addMesh(j2, new THREE.TorusGeometry(0.124 + (i % 2) * 0.008, 0.013, 7, 24), M.fabricDark, 'arm', [0, 0, z]);
    });
    // 第一道黑色束带（J3 附近）+ 带扣
    this.addMesh(j2, new THREE.TorusGeometry(0.130, 0.017, 8, 26), M.dark, 'arm', [0, 0, L1 - 0.27]);
    this.addMesh(j2, new THREE.BoxGeometry(0.055, 0.028, 0.032), M.dark, 'arm', [0.10, 0.058, L1 - 0.27]);
    this.addMesh(j2, new THREE.BoxGeometry(0.016, 0.040, 0.026), M.steel, 'arm', [0.10, 0.058, L1 - 0.27]);
    // 背部管线束
    const cable1 = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.03, -0.10, 0.08),
      new THREE.Vector3(0.05, -0.155, 0.34),
      new THREE.Vector3(0.04, -0.145, 0.66),
      new THREE.Vector3(0.02, -0.10, L1 - 0.04)
    ]);
    this.addMesh(j2, new THREE.TubeGeometry(cable1, 20, 0.019, 7, false), M.rubber, 'arm');
    [-0.02, 0.34, 0.70].forEach((z) => {
      this.addMesh(j2, new THREE.TorusGeometry(0.135, 0.010, 6, 22), M.fabricDark, 'arm', [0, 0, z]);
    });

    const j3 = new THREE.Group();
    j3.name = 'J3';
    j3.position.set(0, 0, L1);
    j2.add(j3);
    const elbow = new THREE.Mesh(new THREE.SphereGeometry(0.175, 22, 14), M.fabric);
    elbow.scale.set(0.96, 1.0, 0.9);
    elbow.castShadow = elbow.receiveShadow = true;
    elbow.userData.layer = 'arm';
    j3.add(elbow);
    this.armMeshes.push(elbow);
    [-0.08, 0.06].forEach((z) => {
      this.addMesh(j3, new THREE.TorusGeometry(0.158, 0.016, 8, 24), M.fabricDark, 'arm', [0, 0, z], [0, Math.PI / 2, 0]);
    });

    // 小臂：布罩细管 + 褶皱 + 第二道束带
    const foreLen = L2 - 0.12;
    this.addMesh(j3, new THREE.CylinderGeometry(0.104, 0.092, foreLen, 20), M.fabric, 'arm', [0, 0, 0.06 + foreLen / 2], [Math.PI / 2, 0, 0]);
    [0.18, 0.34, 0.50, 0.66].forEach((z, i) => {
      this.addMesh(j3, new THREE.TorusGeometry(0.101 + (i % 2) * 0.006, 0.011, 7, 22), M.fabricDark, 'arm', [0, 0, z]);
    });
    this.addMesh(j3, new THREE.TorusGeometry(0.108, 0.015, 8, 24), M.dark, 'arm', [0, 0, L2 - 0.17]);
    this.addMesh(j3, new THREE.BoxGeometry(0.048, 0.024, 0.028), M.dark, 'arm', [0.082, 0.046, L2 - 0.17]);
    const cable2 = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.02, -0.085, 0.06),
      new THREE.Vector3(0.04, -0.128, 0.32),
      new THREE.Vector3(0.02, -0.115, 0.60),
      new THREE.Vector3(0, -0.085, L2 - 0.06)
    ]);
    this.addMesh(j3, new THREE.TubeGeometry(cable2, 18, 0.016, 7, false), M.rubber, 'arm');

    const j4 = new THREE.Group();
    j4.name = 'J4';
    j4.position.set(0, 0, L2);
    j3.add(j4);
    const wristA = new THREE.Mesh(new THREE.SphereGeometry(0.105, 20, 12), M.fabric);
    wristA.castShadow = wristA.receiveShadow = true;
    wristA.userData.layer = 'arm';
    j4.add(wristA);
    this.armMeshes.push(wristA);
    this.addMesh(j4, new THREE.TorusGeometry(0.094, 0.012, 7, 22), M.fabricDark, 'arm', [0, 0, 0.035]);

    const j5 = new THREE.Group();
    j5.name = 'J5';
    j4.add(j5);
    const wristB = new THREE.Mesh(new THREE.SphereGeometry(0.092, 18, 12), M.fabric);
    wristB.scale.set(1.05, 1.0, 1.0);
    wristB.castShadow = wristB.receiveShadow = true;
    wristB.userData.layer = 'arm';
    j5.add(wristB);
    this.armMeshes.push(wristB);
    this.addMesh(j5, new THREE.CylinderGeometry(0.082, 0.082, 0.03, 20), M.steel, 'arm', [0, 0, 0.075], [Math.PI / 2, 0, 0]);

    const j6 = new THREE.Group();
    j6.name = 'J6';
    j6.position.set(0, 0, 0.14);
    j5.add(j6);
    this.jointGroups = [j1, j2, j3, j4, j5, j6];
    this.addMesh(j6, new THREE.CylinderGeometry(0.078, 0.078, 0.055, 22), M.steel, 'arm', [0, 0, 0.025], [Math.PI / 2, 0, 0]);
    this.addMesh(j6, new THREE.CylinderGeometry(0.070, 0.070, 0.012, 22), M.silver, 'arm', [0, 0, 0.055], [Math.PI / 2, 0, 0]);

    /* 末端执行器：银灰转接块 + 蓝色平行夹爪 */
    this.toolMount = new THREE.Group();
    this.toolMount.name = 'ToolMount';
    j6.add(this.toolMount);
    this.nozzleGroup = new THREE.Group();
    this.nozzleGroup.name = 'Tool_Gripper';
    this.toolMount.add(this.nozzleGroup);
    this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.125, 0.108, 0.085), M.steel, 'nozzle', [0, 0, 0.108]);
    [-1, 1].forEach((sx) => [-1, 1].forEach((sy) => {
      this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.006, 0.006, 0.008, 6), M.dark, 'nozzle',
        [sx * 0.043, sy * 0.034, 0.152], [Math.PI / 2, 0, 0]);
    }));
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.012, 0.012, 0.03, 10), M.dark, 'nozzle', [0.074, -0.02, 0.108], [0, 0, Math.PI / 2]);
    this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.115, 0.092, 0.11), M.silver, 'nozzle', [0, 0, 0.205]);
    this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.118, 0.018, 0.112), M.bodyBlue, 'nozzle', [0, 0.036, 0.205]);
    [-1, 1].forEach((s) => {
      this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.010, 0.010, 0.075, 10), M.steel, 'nozzle', [s * 0.040, -0.052, 0.268], [Math.PI / 2, 0, 0]);
      this.addMesh(this.nozzleGroup, new THREE.BoxGeometry(0.032, 0.02, 0.10), M.steel, 'nozzle', [s * 0.040, -0.052, 0.315]);
    });
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.007, 0.007, 0.012, 10), M.led, 'nozzle', [0, 0.046, 0.262]);

    this.fingers = [];
    [-1, 1].forEach((side) => {
      const g = new THREE.Group();
      g.position.x = side * 0.078;
      this.nozzleGroup.add(g);
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.108, 0.10), M.bodyBlue);
      plate.position.set(0, 0, 0.325);
      plate.castShadow = plate.receiveShadow = true;
      plate.userData.layer = 'nozzle';
      g.add(plate);
      this.nozzleMeshes.push(plate);
      const pad = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.082, 0.072), M.bodyBlueDark);
      pad.position.set(-side * 0.012, 0, 0.352);
      pad.castShadow = pad.receiveShadow = true;
      pad.userData.layer = 'nozzle';
      g.add(pad);
      this.nozzleMeshes.push(pad);
      for (let i = 0; i < 5; i++) {
        const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.012, 0.066), M.silver);
        tooth.position.set(-side * 0.021, -0.032 + i * 0.016, 0.352);
        tooth.userData.layer = 'nozzle';
        g.add(tooth);
        this.nozzleMeshes.push(tooth);
      }
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.023, 0.024, 0.06), M.bodyBlue);
      foot.position.set(-side * 0.008, 0, 0.386);
      foot.userData.layer = 'nozzle';
      g.add(foot);
      this.nozzleMeshes.push(foot);
      this.fingers.push({ group: g, side: side });
    });
    this.applyGripperPose();

    this.tcp = new THREE.Object3D();
    this.tcp.name = 'TCP';
    // J6 轴到 TCP 共 0.56m（j6 相对 J5 偏置 0.14m，夹爪指尖再 0.42m）
    this.tcp.position.set(0, 0, R.L3 - 0.14);
    j6.add(this.tcp);
    this.tcpRef = this.tcp;
    this.root.updateMatrixWorld(true);
  };

  RobotRig.prototype.applyGripperPose = function () {
    if (!this.fingers) return;
    const off = 0.045 + this.gripperOpen * 0.033;
    this.fingers.forEach((f) => { f.group.position.x = f.side * off; });
  };

  RobotRig.prototype.setGripper = function (open) {
    this.gripperTarget = U.clamp(Number(open) || 0, 0, 1);
  };

  RobotRig.prototype.updateChain = function () {
    if (!this.chainLinks || !this.chainLinks.length) return;
    const top = (this.liftCarriage ? this.liftCarriage.position.y : R.baseY + this.liftY) + 0.13;
    const A = new THREE.Vector3(0.247, 0.80, 0.075);
    const B = new THREE.Vector3(0.247, top, 0.112);
    const slack = U.clamp((1.62 - top) * 0.30, 0, 0.22);
    const C = new THREE.Vector3(0.247, (A.y + B.y) * 0.5 + 0.02, 0.09 + slack);
    const curve = new THREE.QuadraticBezierCurve3(A, C, B);
    const n = this.chainLinks.length;
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const p = curve.getPoint(t);
      const tan = curve.getTangent(t).normalize();
      const link = this.chainLinks[i];
      link.position.copy(p);
      link.quaternion.setFromUnitVectors(up, tan);
    }
  };

  RobotRig.prototype.setLift = function (h, instant) {
    const L = R.lift || { min: 0, max: 0.6, home: 0 };
    const v = U.clamp(Number(h) || 0, L.min, L.max);
    this.liftTarget = v;
    if (instant) this.liftY = v;
    this.liftCarriage.position.y = R.baseY + this.liftY;
    this.updateChain();
    return this.liftY;
  };

  RobotRig.prototype.getLift = function () { return this.liftY; };

  RobotRig.prototype.buildHose = function () {
    this.hoseGroup = new THREE.Group();
    this.hoseGroup.name = 'Hose';
    this.scene.add(this.hoseGroup);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: this.makeHoseTexture(), roughness: 0.74, metalness: 0.04 });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.hoseMesh = mesh;
    this.hoseGroup.add(mesh);
    this._hoseStartLocal = new THREE.Vector3(0.324, 1.06, -0.10);
    this._hosePts = null;
    this._hoseVel = null;
    this._hoseLastTarget = null;
    this.updateHose(true, 0.016);
  };

  RobotRig.prototype.makeHoseTexture = function () {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 32;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#1d232c';
    ctx.fillRect(0, 0, 64, 32);
    for (let x = 0; x < 64; x += 8) {
      ctx.fillStyle = '#2a333f';
      ctx.fillRect(x, 0, 3, 32);
      ctx.fillStyle = '#12171d';
      ctx.fillRect(x + 4, 0, 2, 32);
    }
    for (let i = 0; i < 90; i++) {
      const g = 28 + Math.floor(Math.random() * 22);
      ctx.fillStyle = 'rgba(' + g + ',' + (g + 6) + ',' + (g + 12) + ',.35)';
      ctx.fillRect(Math.random() * 64, Math.random() * 32, 1, 1);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(22, 1);
    return tex;
  };

  // 管线束：立柱出口 → 拖链 → 大臂 → 小臂 → 腕部 → 夹爪
  RobotRig.prototype.hoseTargets = function () {
    const g = this.jointGroups;
    const start = this.root.localToWorld(this._hoseStartLocal.clone());
    if (g.length !== 6) return [start, this.getTCP().position.clone()];
    const toW = (obj, p) => obj.localToWorld(p);
    const pts = [
      start,
      toW(this.liftCarriage, new THREE.Vector3(0.247, 0.10, 0.075)),
      toW(g[1], new THREE.Vector3(0.045, -0.145, 0.30)),
      toW(g[1], new THREE.Vector3(0.045, -0.140, 0.80)),
      toW(g[2], new THREE.Vector3(0.030, -0.100, 0.30)),
      toW(g[2], new THREE.Vector3(0.020, -0.095, 0.66)),
      toW(g[4], new THREE.Vector3(0, -0.070, 0.02))
    ];
    const endParent = this.toolMount || this.nozzleGroup || this.tcp;
    pts.push(endParent.localToWorld(new THREE.Vector3(0, -0.052, 0.13)));
    return pts;
  };

  RobotRig.prototype.updateHose = function (force, dt) {
    if (!this.hoseMesh) return;
    this.root.updateMatrixWorld(true);
    const targets = this.hoseTargets();
    const n = targets.length;
    const endJump = this._hoseLastTarget ? targets[n - 1].distanceTo(this._hoseLastTarget) : 0;
    if (force || !this._hosePts || this._hosePts.length !== n || endJump > 0.55) {
      this._hosePts = targets.map((p) => p.clone());
      this._hoseVel = targets.map(() => new THREE.Vector3());
    } else {
      const h = Math.max(0.016, Math.min(0.12, dt || 0.09));
      const stiffness = 34, damping = 9, maxV = 5.5;
      for (let i = 1; i < n - 1; i++) {
        const p = this._hosePts[i], v = this._hoseVel[i], t = targets[i];
        const ty = t.y - 0.018 * Math.sin(Math.PI * i / (n - 1));
        v.x += ((t.x - p.x) * stiffness - v.x * damping) * h;
        v.y += ((ty - p.y) * stiffness - v.y * damping) * h;
        v.z += ((t.z - p.z) * stiffness - v.z * damping) * h;
        v.clampLength(0, maxV);
        p.addScaledVector(v, h);
      }
      this._hosePts[0].copy(targets[0]);
      this._hosePts[n - 1].copy(targets[n - 1]);
    }
    this._hoseLastTarget = targets[n - 1].clone();
    const curve = new THREE.CatmullRomCurve3(this._hosePts, false, 'catmullrom', 0.35);
    const geo = new THREE.TubeGeometry(curve, 54, 0.012, 8, false);
    this.hoseMesh.geometry.dispose();
    this.hoseMesh.geometry = geo;
  };


  RobotRig.prototype.setJoints = function (angles) {
    const arr = angles.map((v, i) => U.clamp(Number(v) || 0, R.joints[i].min, R.joints[i].max));
    this.currentJoints = arr;
    const [j1, j2, j3, j4, j5, j6] = arr.map(U.deg);
    if (this.jointGroups.length === 6) {
      this.jointGroups[0].rotation.y = j1;
      this.jointGroups[1].rotation.x = j2;
      this.jointGroups[2].rotation.x = j3;
      this.jointGroups[3].rotation.z = j4;
      this.jointGroups[4].rotation.x = j5;
      this.jointGroups[5].rotation.z = j6;
    }
    this.root.updateMatrixWorld(true);
    if (this.custom) this.syncCustomJoints(arr);
  };

  RobotRig.prototype.getJoints = function () { return this.currentJoints.slice(); };

  RobotRig.prototype.setBasePose = function (x, z, yaw) {
    if (typeof x === 'number') this.basePos.x = x;
    if (typeof z === 'number') this.basePos.z = z;
    if (typeof yaw === 'number') this.baseYaw = U.norm180(yaw);
    this.root.position.set(this.basePos.x, 0, this.basePos.z);
    this.root.rotation.y = this.baseYaw;
    this.root.updateMatrixWorld(true);
  };

  RobotRig.prototype.getBasePose = function () {
    return { x: this.basePos.x, z: this.basePos.z, yaw: this.baseYaw };
  };

  RobotRig.prototype.getTCP = function () {
    const ref = this.tcpRef || this.tcp;
    this.root.updateMatrixWorld(true);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    ref.getWorldPosition(position);
    ref.getWorldQuaternion(quaternion);
    const direction = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion).normalize();
    return { position, direction, quaternion };
  };

  RobotRig.prototype.getSamplePoints = function () {
    this.root.updateMatrixWorld(true);
    const pts = [];
    const add = (obj) => {
      if (!obj) return;
      const p = new THREE.Vector3();
      obj.getWorldPosition(p);
      pts.push(p);
    };
    if (this.jointGroups.length === 6) {
      add(this.jointGroups[0]);
      add(this.jointGroups[1]);
      add(this.jointGroups[2]);
      add(this.jointGroups[3]);
      add(this.jointGroups[4]);
      add(this.jointGroups[5]);
      add(this.tcpRef || this.tcp);
      // 沿大臂、小臂、腕部加密采样，避免长连杆中段穿墙/穿机体被漏检
      const linkSample = (a, b, ts) => {
        const p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
        a.getWorldPosition(p1);
        b.getWorldPosition(p2);
        ts.forEach((t) => pts.push(p1.clone().lerp(p2, t)));
      };
      linkSample(this.jointGroups[1], this.jointGroups[2], [0.2, 0.4, 0.6, 0.8]);
      linkSample(this.jointGroups[2], this.jointGroups[3], [0.25, 0.5, 0.75]);
      linkSample(this.jointGroups[3], this.jointGroups[4], [0.5]);
      linkSample(this.jointGroups[4], this.jointGroups[5], [0.5]);
      linkSample(this.jointGroups[5], this.tcpRef || this.tcp, [0.5]);
    }
    return pts;
  };

  // 机体自身碰撞：AGV 底盘与升降立柱（局部坐标包围盒）
  RobotRig.prototype.bodyCollision = function (points, margin) {
    if (!this.bodyBoxes) {
      this.bodyBoxes = [
        { name: '底盘', min: [-0.40, 0.05, -0.53], max: [0.40, 0.80, 0.53] },
        { name: '升降立柱', min: [-0.28, 0.775, -0.30], max: [0.28, 1.92, 0.06] }
      ];
    }
    const m = margin == null ? 0.04 : margin;
    this.root.updateMatrixWorld(true);
    for (let i = 0; i < points.length; i++) {
      const q = this.root.worldToLocal(points[i].clone());
      for (let b = 0; b < this.bodyBoxes.length; b++) {
        const box = this.bodyBoxes[b];
        if (q.x > box.min[0] - m && q.x < box.max[0] + m &&
          q.y > box.min[1] - m && q.y < box.max[1] + m &&
          q.z > box.min[2] - m && q.z < box.max[2] + m) {
          return { hit: true, reason: box.name, point: points[i] };
        }
      }
    }
    return { hit: false };
  };

  RobotRig.prototype.setLayer = function (name, visible) {
    this._layerState[name] = !!visible;
    if (name === 'chassis') {
      this.chassisMeshes.forEach((m) => { m.visible = visible; });
    } else if (name === 'arm') {
      this.armMeshes.forEach((m) => { m.visible = visible && !this.custom; });
      if (this.custom && this.custom.group) this.custom.group.visible = !!visible;
    } else if (name === 'nozzle') {
      this.nozzleMeshes.forEach((m) => { m.visible = visible && !this.custom; });
      if (this.toolMount) this.toolMount.visible = visible && !this.custom;
      if (SB.Tools && SB.Tools.applyVisibility) SB.Tools.applyVisibility(visible);
    } else if (name === 'hose' && this.hoseGroup) {
      this.hoseGroup.visible = visible;
    }
  };

  RobotRig.prototype.updateWheels = function (dt) {
    if (!this.driveWheels || !this.casters) return;
    if (!this._wheelLast) {
      this._wheelLast = { x: this.basePos.x, z: this.basePos.z, yaw: this.baseYaw };
      return;
    }
    const last = this._wheelLast;
    const dx = this.basePos.x - last.x;
    const dz = this.basePos.z - last.z;
    const dyaw = U.norm180(this.baseYaw - last.yaw);
    if (Math.hypot(dx, dz) > 0.6 || Math.abs(dyaw) > 0.8) {
      this._wheelLast = { x: this.basePos.x, z: this.basePos.z, yaw: this.baseYaw };
      return;
    }
    if (Math.hypot(dx, dz) < 1e-5 && Math.abs(dyaw) < 1e-5) return;
    const cos = Math.cos(last.yaw), sin = Math.sin(last.yaw);
    const lx = dx * cos - dz * sin;
    const lz = dx * sin + dz * cos;
    const omega = dt > 1e-4 ? dyaw / dt : 0;
    // 驱动轮随行进/差速转动
    this.driveWheels.forEach((w) => {
      w.spin.rotation.x += (lz - omega * w.x) / w.radius;
    });
    // 万向轮：按该轮处的合成速度转向，并沿滚动方向自转
    this.casters.forEach((c) => {
      const vx = lx + omega * c.z;
      const vz = lz - omega * c.x;
      const speed = Math.hypot(vx, vz);
      if (speed < 0.004) return;
      const target = Math.atan2(vx, vz);
      const diff = U.norm180(target - c.angle);
      const step = Math.min(Math.abs(diff), (2.2 + speed * 2.5) * dt);
      c.angle = U.norm180(c.angle + Math.sign(diff) * step);
      c.steer.rotation.y = c.angle;
      const along = vx * Math.sin(c.angle) + vz * Math.cos(c.angle);
      c.spin.rotation.x += along / c.radius;
    });
    this._wheelLast = { x: this.basePos.x, z: this.basePos.z, yaw: this.baseYaw };
  };

  RobotRig.prototype.update = function (dt) {
    this._hoseClock += dt;
    if (this._hoseClock > 0.09) {
      this._hoseClock = 0;
      this.updateHose(false, 0.09);
    }
    if (this.liftY !== this.liftTarget) {
      const sp = (R.lift && R.lift.speed) || 0.32;
      const d = this.liftTarget - this.liftY;
      this.liftY += Math.sign(d) * Math.min(Math.abs(d), sp * dt);
      if (this.liftCarriage) this.liftCarriage.position.y = R.baseY + this.liftY;
      this.updateChain();
    }
    if (Math.abs(this.gripperOpen - this.gripperTarget) > 1e-4) {
      const d = this.gripperTarget - this.gripperOpen;
      this.gripperOpen += Math.sign(d) * Math.min(Math.abs(d), 1.8 * dt);
      this.applyGripperPose();
    }
    this.updateWheels(dt);
  };
  RobotRig.prototype.computeHomeJoints = function () {
    // 目标点按底盘当前朝向转换到世界坐标，侧墙作业时也保持在机器人正前方
    const yaw = this.baseYaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const target = new THREE.Vector3(
      this.basePos.x + fx * 1.15 + rx * -0.4,
      1.45,
      this.basePos.z + fz * 1.15 + rz * -0.4
    );
    const sol = this.solveIK(target, new THREE.Vector3(fx, 0, fz));
    if (sol && sol.angles.every((v) => isFinite(v))) return sol.angles;
    return [0, -35, 70, 0, -35, 0];
  };

  // 转运姿态：机械臂收拢在设备前方，避免从机柜顶部翻越造成穿模
  RobotRig.prototype.computeTransportJoints = function () {
    const yaw = this.baseYaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const target = new THREE.Vector3(this.basePos.x + fx * 0.9, 1.4, this.basePos.z + fz * 0.9);
    const sol = this.solveIK(target, new THREE.Vector3(0, -1, 0), this.currentJoints);
    if (sol && sol.angles.every((v) => isFinite(v))) return sol.angles;
    return this.computeHomeJoints();
  };

  /**
   * 解析逆解。
   * @param {THREE.Vector3} target 喷枪 TCP 目标
   * @param {THREE.Vector3} direction 喷枪方向
   * @param {number[]} [preferred] 连续性参考关节角
   * @param {number} [branch] 指定肘部分支（1 / -1），省略时自动选择
   */
  RobotRig.prototype.solveIK = function (target, direction, preferred, branch) {
    const P = target.clone ? target.clone() : new THREE.Vector3(target[0], target[1], target[2]);
    const D = direction.clone ? direction.clone() : new THREE.Vector3(direction[0], direction[1], direction[2]);
    if (D.lengthSq() < 1e-9) return null;
    D.normalize();
    const shoulder = this.shoulderPoint();
    const L1 = R.L1, L2 = R.L2, L3 = R.L3;

    const wrist = P.clone().addScaledVector(D, -L3);
    const dx = wrist.x - shoulder.x;
    const dz = wrist.z - shoulder.z;
    const thetaW = Math.atan2(dx, dz);
    const j1 = U.norm180(U.rad(thetaW - this.baseYaw));
    const r = Math.hypot(dx, dz);
    const wy = wrist.y - shoulder.y;
    let rw = r, wyw = wy;
    const reach = L1 + L2;
    const minReach = Math.abs(L1 - L2) + 0.02;
    const R0 = Math.hypot(rw, wyw);
    let scaled = false;
    if (R0 > reach - 0.008) {
      const k = (reach - 0.008) / Math.max(R0, 1e-6);
      rw *= k; wyw *= k; scaled = true;
    } else if (R0 < minReach) {
      const k = minReach / Math.max(R0, 1e-6);
      rw *= k; wyw *= k; scaled = true;
    }
    const R2 = Math.hypot(rw, wyw);
    if (R2 < 1e-6) return null;
    const phi = Math.atan2(wyw, rw);
    const cosAlpha = U.clamp((L1 * L1 + R2 * R2 - L2 * L2) / (2 * L1 * R2), -1, 1);
    const alpha = Math.acos(cosAlpha);
    const c = Math.cos(thetaW), s = Math.sin(thetaW);
    const Dlx = D.x * c - D.z * s;
    const Dly = D.y;
    const Dlz = D.x * s + D.z * c;

    let candidates = [];
    [1, -1].forEach((sign) => {
      const beta1 = phi + sign * alpha;
      const er = L1 * Math.cos(beta1);
      const ey = L1 * Math.sin(beta1);
      const beta2 = Math.atan2(wyw - ey, rw - er);
      const j2 = U.rad(-beta1);
      const j3 = U.rad(-(beta2 - beta1));
      const a = U.deg(j2 + j3);
      const sinA = Math.sin(a), cosA = Math.cos(a);
      const dot = -Dly * sinA + Dlz * cosA;
      const perp = Math.sqrt(Math.max(0, 1 - dot * dot));
      let j4 = U.rad(Math.atan2(Dlx, -(Dly * Math.cos(a) + Dlz * Math.sin(a))));
      let j5 = U.rad(Math.atan2(perp, dot));
      if (Math.abs(j5) > 130) { j4 = U.norm180(j4 + 180); j5 = -j5; }
      if (Math.abs(j5) > 130) { j4 = U.norm180(j4 + 180); j5 = -j5; }
      candidates.push({ angles: [j1, j2, j3, U.norm180(j4), j5, 0], sign });
      // 腕部翻转等价解：J4+180、J5 取反。经过 J5=0 的奇异位形时，
      // 该解可避免 J4 突跳约 180°，由连续性评分自动择优。
      if (Math.abs(j5) <= 130) {
        candidates.push({ angles: [j1, j2, j3, U.norm180(j4 + 180), -j5, 0], sign });
      }
    });

    const scoreCandidate = (cand) => {
      const angles = cand.angles;
      let violation = 0, out = 0;
      for (let i = 0; i < 6; i++) {
        const jt = R.joints[i];
        if (angles[i] < jt.min || angles[i] > jt.max) {
          out++;
          violation += angles[i] < jt.min ? jt.min - angles[i] : angles[i] - jt.max;
        }
      }
      let continuity = 0;
      if (preferred && preferred.length === 6) {
        for (let i = 0; i < 6; i++) continuity += Math.abs(U.norm180(angles[i] - preferred[i]));
      }
      return out * 1000 + violation * 60 + continuity * 0.35 + (cand.sign > 0 ? 0 : 45) +
        Math.abs(angles[3]) * 0.03 + Math.abs(angles[4]) * 0.06;
    };
    if (branch === 1 || branch === -1) {
      candidates = candidates.filter((cand) => cand.sign === branch);
      if (!candidates.length) return null;
    }
    candidates.sort((A, B) => scoreCandidate(A) - scoreCandidate(B));
    const best = candidates[0];
    const angles = best.angles.map((v, i) => U.clamp(v, R.joints[i].min, R.joints[i].max));
    const fk = this.forward(angles);
    const posErr = fk.position.distanceTo(P);
    const dirErr = U.rad(Math.acos(U.clamp(fk.direction.dot(D), -1, 1)));
    const limitOK = angles.every((v, i) => v >= R.joints[i].min - 1e-6 && v <= R.joints[i].max + 1e-6);
    return {
      angles, reachable: !scaled && limitOK && posErr < 0.02 && dirErr < 2,
      scaled, limitOK, posError: posErr, dirError: dirErr, fk, branch: best.sign
    };
  };
  // 肩部（J2 轴）世界坐标：随底盘位姿、升降高度与臂座偏置变化
  RobotRig.prototype.shoulderPoint = function () {
    const yaw = this.baseYaw;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const off = R.armOffsetZ || 0;
    return new THREE.Vector3(
      this.basePos.x + off * s,
      R.baseY + R.shoulderY + this.liftY,
      this.basePos.z + off * c
    );
  };

  RobotRig.prototype.forward = function (angles) {
    const a2 = U.deg(angles[1]);
    const a3 = U.deg(angles[2]);
    const a = a2 + a3;
    const rW = R.L1 * Math.cos(a2) + R.L2 * Math.cos(a);
    const yW = -R.L1 * Math.sin(a2) - R.L2 * Math.sin(a);
    const j4 = U.deg(angles[3]);
    const j5 = U.deg(angles[4]);
    const sinA = Math.sin(a), cosA = Math.cos(a);
    const dirLocal = new THREE.Vector3(
      Math.sin(j5) * Math.sin(j4),
      -Math.sin(j5) * Math.cos(j4) * cosA - Math.cos(j5) * sinA,
      -Math.sin(j5) * Math.cos(j4) * sinA + Math.cos(j5) * cosA
    ).normalize();
    const local = new THREE.Vector3(0, yW, rW).addScaledVector(dirLocal, R.L3);
    const theta = this.baseYaw + U.deg(angles[0]);
    const c = Math.cos(theta), s = Math.sin(theta);
    const shoulder = this.shoulderPoint();
    const position = new THREE.Vector3(
      shoulder.x + local.x * c + local.z * s,
      shoulder.y + local.y,
      shoulder.z - local.x * s + local.z * c
    );
    const direction = new THREE.Vector3(
      dirLocal.x * c + dirLocal.z * s,
      dirLocal.y,
      -dirLocal.x * s + dirLocal.z * c
    ).normalize();
    return { position, direction };
  };

  RobotRig.prototype.selfTest = function () {
    const Rm = C.room;
    const saved = this.getBasePose();
    const tests = [];
    const run = (name, base, p, d) => {
      this.setBasePose(base[0], base[1], base[2]);
      const sol = this.solveIK(new THREE.Vector3(...p), new THREE.Vector3(...d));
      if (!sol) {
        tests.push({ name: name, ok: false, error: '无解' });
        return;
      }
      tests.push({
        name: name,
        ok: sol.posError < 0.02 && sol.dirError < 2,
        posError: Number((sol.posError * 1000).toFixed(3)),
        dirError: Number(sol.dirError.toFixed(3)),
        angles: sol.angles.map((v) => Number(v.toFixed(2)))
      });
    };
    run('墙面中心', [0, Rm.wallZ + 1.9, R.yawOffset], [0, 1.55, Rm.wallZ + 0.34], [0, 0, -1]);
    run('墙面向右', [0, Rm.wallZ + 1.9, R.yawOffset], [1.2, 1.7, Rm.wallZ + 0.34], [0, 0, -1]);
    run('天花板', [0, 0, R.yawOffset], [0, Rm.height - 0.34, -0.6], [0, 1, 0]);
    run('地面', [0, 0, R.yawOffset], [0, 0.34, -1.1], [0, -1, 0]);
    this.setBasePose(saved.x, saved.z, saved.yaw);
    return tests;
  };
  RobotRig.prototype.loadGLB = function (file) {
    const self = this;
    return new Promise((resolve, reject) => {
      if (!file) { reject(new Error('未选择文件')); return; }
      if (!window.THREE.GLTFLoader) { reject(new Error('GLTFLoader 未加载')); return; }
      const url = URL.createObjectURL(file);
      const loader = new THREE.GLTFLoader();
      loader.load(url, (gltf) => {
        URL.revokeObjectURL(url);
        try {
          const info = self.applyCustomModel(gltf, file.name);
          resolve(info);
        } catch (e) {
          reject(e);
        }
      }, undefined, (err) => {
        URL.revokeObjectURL(url);
        reject(new Error('GLB 解析失败：' + (err && err.message ? err.message : '格式不支持')));
      });
    });
  };

  RobotRig.prototype.applyCustomModel = function (gltf, fileName) {
    const scene = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    if (!scene) throw new Error('GLB 中未找到场景');
    const wanted = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'];
    const found = {};
    scene.traverse((obj) => {
      if (!obj.name) return;
      const n = obj.name.toLowerCase();
      const hit = wanted.find((w) => n === w.toLowerCase() || n.startsWith(w.toLowerCase() + '_') || n.startsWith(w.toLowerCase() + '-'));
      if (hit && !found[hit]) found[hit] = obj;
    });
    const missing = wanted.filter((w) => !found[w]);
    if (missing.length) throw new Error('GLB 缺少关节节点：' + missing.join(', ') + '（需命名为 J1–J6）');

    if (this.custom && this.custom.group) {
      this.root.remove(this.custom.group);
    }
    scene.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        obj.userData.layer = 'custom';
      }
    });
    this.root.add(scene);

    const baseQuats = {};
    wanted.forEach((name) => {
      baseQuats[name] = found[name].quaternion.clone();
    });
    let tip = null;
    scene.traverse((obj) => {
      if (tip) return;
      const n = (obj.name || '').toLowerCase();
      if (n === 'tip' || n === 'tcp' || n === 'nozzle' || n.includes('nozzletip')) tip = obj;
    });
    if (!tip) {
      tip = new THREE.Object3D();
      tip.name = 'TIP_AUTO';
      tip.position.set(0, 0, 0.35);
      found.J6.add(tip);
    }

    this.custom = { group: scene, nodes: found, baseQuats, tip, fileName: fileName || 'custom.glb' };
    scene.visible = !!this._layerState.arm;
    this.armMeshes.forEach((m) => { m.visible = false; });
    this.nozzleMeshes.forEach((m) => { m.visible = false; });
    if (this.toolMount) this.toolMount.visible = false;
    this.tcpRef = tip;
    this.syncCustomJoints(this.currentJoints);
    this.root.updateMatrixWorld(true);
    this.updateHose(true);
    return { joints: wanted.length, fileName: this.custom.fileName };
  };

  RobotRig.prototype.syncCustomJoints = function (angles) {
    if (!this.custom) return;
    const axes = ['y', 'x', 'x', 'z', 'x', 'z'];
    const names = ['J1', 'J2', 'J3', 'J4', 'J5', 'J6'];
    for (let i = 0; i < 6; i++) {
      const node = this.custom.nodes[names[i]];
      if (!node) continue;
      const q = this.custom.baseQuats[names[i]].clone();
      const e = new THREE.Euler(0, 0, 0);
      e[axes[i]] = U.deg(angles[i]);
      q.multiply(new THREE.Quaternion().setFromEuler(e));
      node.quaternion.copy(q);
    }
    this.root.updateMatrixWorld(true);
  };

  RobotRig.prototype.resetModel = function () {
    if (this.custom && this.custom.group) {
      this.root.remove(this.custom.group);
      this.custom.group.traverse((obj) => {
        if (obj.isMesh) {
          if (obj.geometry) obj.geometry.dispose();
          if (obj.material) {
            const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
            mats.forEach((m) => m.dispose());
          }
        }
      });
    }
    this.custom = null;
    this.tcpRef = this.tcp;
    this.armMeshes.forEach((m) => { m.visible = this._layerState.arm; });
    this.nozzleMeshes.forEach((m) => { m.visible = this._layerState.nozzle; });
    if (this.toolMount) this.toolMount.visible = this._layerState.nozzle;
    if (SB.Tools && SB.Tools.applyVisibility) SB.Tools.applyVisibility(this._layerState.nozzle);
    this.setJoints(this.currentJoints);
    this.updateHose(true);
  };

  SB.Robot = {
    init(sceneMgr) { return new RobotRig(sceneMgr); },
    RobotRig
  };
})();
