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

    this.materials = {
      blue: new THREE.MeshStandardMaterial({ color: 0x0066cc, metalness: 0.42, roughness: 0.34 }),
      blueDark: new THREE.MeshStandardMaterial({ color: 0x0a4a88, metalness: 0.5, roughness: 0.32 }),
      blueLight: new THREE.MeshStandardMaterial({ color: 0x2b8ce6, metalness: 0.35, roughness: 0.38 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x28313d, metalness: 0.55, roughness: 0.42 }),
      steel: new THREE.MeshStandardMaterial({ color: 0x98a4b3, metalness: 0.82, roughness: 0.28 }),
      yellow: new THREE.MeshStandardMaterial({ color: 0xffcc00, metalness: 0.25, roughness: 0.42 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x171b22, metalness: 0.05, roughness: 0.92 }),
      white: new THREE.MeshStandardMaterial({ color: 0xe9eef4, metalness: 0.15, roughness: 0.5 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xcbe7f7, metalness: 0.1, roughness: 0.08, transparent: true, opacity: 0.42 }),
      led: new THREE.MeshStandardMaterial({ color: 0x22d37a, emissive: 0x22d37a, emissiveIntensity: 2.0 }),
      orange: new THREE.MeshStandardMaterial({ color: 0xff8a1e, metalness: 0.2, roughness: 0.45 })
    };

    this.buildChassis();
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
  RobotRig.prototype.buildChassis = function () {
    const M = this.materials;
    this.chassisGroup = new THREE.Group();
    this.chassisGroup.name = 'Chassis';
    this.root.add(this.chassisGroup);

    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(1.14, 0.34, 0.82), M.blue, 'chassis', [0, 0.38, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(1.18, 0.15, 0.86), M.dark, 'chassis', [0, 0.18, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(1.2, 0.06, 0.88), M.blueDark, 'chassis', [0, 0.58, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(1.16, 0.05, 0.84), M.dark, 'chassis', [0, 0.62, 0]);

    const wheelGeo = new THREE.CylinderGeometry(0.16, 0.16, 0.11, 24);
    [[-0.55, -0.31], [0.55, -0.31], [-0.55, 0.31], [0.55, 0.31]].forEach(([x, z]) => {
      this.addMesh(this.chassisGroup, wheelGeo, M.rubber, 'chassis', [x, 0.17, z], [0, 0, Math.PI / 2]);
      this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.07, 0.07, 0.125, 16), M.steel, 'chassis', [x, 0.17, z], [0, 0, Math.PI / 2]);
    });

    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(1.06, 0.1, 0.07), M.yellow, 'chassis', [0, 0.22, 0.45]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(1.06, 0.1, 0.07), M.yellow, 'chassis', [0, 0.22, -0.45]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(1.2, 0.045, 0.9), M.blueLight, 'chassis', [0, 0.48, 0]);
    for (let i = -1; i <= 1; i++) {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.08, 0.16, 0.025), M.yellow, 'chassis', [i * 0.34, 0.36, 0.414]);
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.08, 0.16, 0.025), M.yellow, 'chassis', [i * 0.34, 0.36, -0.414]);
    }

    // 料桶
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.18, 0.18, 0.56, 24), M.white, 'chassis', [0.0, 0.93, -0.3]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.185, 0.185, 0.1, 24), M.blue, 'chassis', [0.0, 1.02, -0.3]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.14, 0.18, 0.07, 24), M.steel, 'chassis', [0.0, 1.24, -0.3]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.035, 0.035, 0.12, 12), M.dark, 'chassis', [0.0, 1.29, -0.3]);
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.032, 0.032, 0.34, 10), M.rubber, 'chassis', [0.26, 0.82, -0.1], [0, 0, Math.PI / 2]);

    // 控制面板
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.28, 0.16, 0.08), M.dark, 'chassis', [0.42, 0.52, 0.3], [-0.35, 0, 0]);
    this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.17, 0.09, 0.01), M.glass, 'chassis', [0.42, 0.525, 0.345], [-0.35, 0, 0]);
    const led = this.addMesh(this.chassisGroup, new THREE.SphereGeometry(0.018, 12, 8), M.led, 'chassis', [0.51, 0.57, 0.35]);
    led.castShadow = false;

    // 激光雷达
    this.addMesh(this.chassisGroup, new THREE.CylinderGeometry(0.08, 0.09, 0.07, 18), M.dark, 'chassis', [-0.38, 0.66, 0.26]);
    this.addMesh(this.chassisGroup, new THREE.SphereGeometry(0.065, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), M.steel, 'chassis', [-0.38, 0.7, 0.26]);

    // 车身标识
    const tex = this.labelTexture('SPRAY-X1', 'WALL SPRAYING ROBOT');
    const labelMat = new THREE.MeshBasicMaterial({ map: tex });
    const l1 = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.12), labelMat);
    l1.position.set(0.581, 0.38, 0.03); l1.rotation.y = Math.PI / 2;
    this.chassisGroup.add(l1);
    const l2 = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.12), labelMat);
    l2.position.set(-0.581, 0.38, 0.03); l2.rotation.y = -Math.PI / 2;
    this.chassisGroup.add(l2);

    for (let s = -1; s <= 1; s += 2) {
      this.addMesh(this.chassisGroup, new THREE.BoxGeometry(0.06, 0.1, 0.66), M.steel, 'chassis', [s * 0.49, 0.18, 0]);
    }
  };
  RobotRig.prototype.buildArm = function () {
    const M = this.materials;
    const L1 = R.L1, L2 = R.L2;
    this.armBase = new THREE.Group();
    this.armBase.name = 'ArmBase';
    this.root.add(this.armBase);

    this.addMesh(this.armBase, new THREE.CylinderGeometry(0.3, 0.34, 0.1, 32), M.dark, 'arm', [0, 0.66, 0]);
    this.addMesh(this.armBase, new THREE.CylinderGeometry(0.27, 0.3, 0.1, 32), M.blue, 'arm', [0, 0.73, 0]);
    this.addMesh(this.armBase, new THREE.CylinderGeometry(0.285, 0.285, 0.028, 32), M.yellow, 'arm', [0, 0.79, 0]);

    const j1 = new THREE.Group(); j1.name = 'J1'; j1.position.set(0, R.baseY, 0); this.armBase.add(j1);
    this.addMesh(j1, new THREE.CylinderGeometry(0.225, 0.25, 0.24, 28), M.blue, 'arm', [0, 0.1, 0]);
    this.addMesh(j1, new THREE.CylinderGeometry(0.235, 0.235, 0.05, 28), M.blueDark, 'arm', [0, 0.23, 0]);
    this.addMesh(j1, new THREE.BoxGeometry(0.3, 0.18, 0.24), M.blueDark, 'arm', [0, 0.23, 0.08]);

    const j2 = new THREE.Group(); j2.name = 'J2'; j2.position.set(0, R.shoulderY, 0); j1.add(j2);
    this.addMesh(j2, new THREE.CylinderGeometry(0.205, 0.205, 0.36, 28), M.dark, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j2, new THREE.CylinderGeometry(0.185, 0.185, 0.38, 28), M.blue, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j2, new THREE.CylinderGeometry(0.12, 0.12, 0.39, 20), M.steel, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);

    // 大臂
    this.addMesh(j2, new THREE.BoxGeometry(0.175, 0.23, 0.72), M.blue, 'arm', [0, 0, 0.45]);
    this.addMesh(j2, new THREE.BoxGeometry(0.15, 0.2, 0.34), M.blue, 'arm', [0, 0, 0.86]);
    this.addMesh(j2, new THREE.BoxGeometry(0.03, 0.26, 0.58), M.dark, 'arm', [0.094, 0, 0.48]);
    this.addMesh(j2, new THREE.BoxGeometry(0.03, 0.26, 0.58), M.dark, 'arm', [-0.094, 0, 0.48]);
    this.addMesh(j2, new THREE.BoxGeometry(0.08, 0.028, 0.58), M.yellow, 'arm', [0, 0.13, 0.5]);
    this.addMesh(j2, new THREE.BoxGeometry(0.19, 0.05, 0.2), M.steel, 'arm', [0, 0, 0.16]);

    const j3 = new THREE.Group(); j3.name = 'J3'; j3.position.set(0, 0, L1); j2.add(j3);
    this.jointGroups.push(j1, j2, j3);
    this.addMesh(j3, new THREE.CylinderGeometry(0.165, 0.165, 0.32, 26), M.dark, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j3, new THREE.CylinderGeometry(0.145, 0.145, 0.34, 26), M.blue, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);

    // 小臂
    this.addMesh(j3, new THREE.BoxGeometry(0.145, 0.19, 0.7), M.blue, 'arm', [0, 0, 0.42]);
    this.addMesh(j3, new THREE.BoxGeometry(0.12, 0.16, 0.24), M.blueDark, 'arm', [0, 0, 0.8]);
    this.addMesh(j3, new THREE.BoxGeometry(0.025, 0.21, 0.58), M.dark, 'arm', [0.078, 0, 0.45]);
    this.addMesh(j3, new THREE.BoxGeometry(0.025, 0.21, 0.58), M.dark, 'arm', [-0.078, 0, 0.45]);
    this.addMesh(j3, new THREE.BoxGeometry(0.065, 0.026, 0.56), M.yellow, 'arm', [0, 0.108, 0.46]);

    const j4 = new THREE.Group(); j4.name = 'J4'; j4.position.set(0, 0, L2); j3.add(j4);
    this.addMesh(j4, new THREE.CylinderGeometry(0.125, 0.125, 0.16, 24), M.dark, 'arm', [0, 0, 0.04], [Math.PI / 2, 0, 0]);
    this.addMesh(j4, new THREE.CylinderGeometry(0.105, 0.105, 0.17, 24), M.steel, 'arm', [0, 0, 0.04], [Math.PI / 2, 0, 0]);
    this.addMesh(j4, new THREE.BoxGeometry(0.14, 0.14, 0.16), M.blueDark, 'arm', [0, 0, 0.1]);

    const j5 = new THREE.Group(); j5.name = 'J5'; j5.position.set(0, 0, 0); j4.add(j5);
    this.addMesh(j5, new THREE.CylinderGeometry(0.105, 0.105, 0.23, 22), M.dark, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j5, new THREE.CylinderGeometry(0.088, 0.088, 0.24, 22), M.steel, 'arm', [0, 0, 0], [0, 0, Math.PI / 2]);
    this.addMesh(j5, new THREE.BoxGeometry(0.11, 0.12, 0.13), M.blueDark, 'arm', [0, 0, 0.07]);

    const j6 = new THREE.Group(); j6.name = 'J6'; j6.position.set(0, 0, 0.14); j5.add(j6);
    this.jointGroups.push(j4, j5, j6);
    this.addMesh(j6, new THREE.CylinderGeometry(0.095, 0.095, 0.09, 22), M.dark, 'arm', [0, 0, 0.045], [Math.PI / 2, 0, 0]);
    this.addMesh(j6, new THREE.CylinderGeometry(0.075, 0.075, 0.1, 20), M.orange, 'arm', [0, 0, 0.095], [Math.PI / 2, 0, 0]);

    // 末端工具安装座（喷涂枪 / 刮刀 / 砂盘共用）
    this.toolMount = new THREE.Group();
    this.toolMount.name = 'ToolMount';
    j6.add(this.toolMount);

    // 喷枪组件（单独图层）
    this.nozzleGroup = new THREE.Group();
    this.nozzleGroup.name = 'Tool_Spray';
    this.toolMount.add(this.nozzleGroup);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.085, 0.085, 0.04, 20), M.steel, 'nozzle', [0, 0, 0.15], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.062, 0.07, 0.12, 20), M.dark, 'nozzle', [0, 0, 0.21], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.018, 0.062, 0.1, 20), M.orange, 'nozzle', [0, 0, 0.3], [Math.PI / 2, 0, 0]);
    this.addMesh(this.nozzleGroup, new THREE.CylinderGeometry(0.019, 0.019, 0.06, 16), M.blue, 'nozzle', [0, 0.09, 0.17], [0, 0, Math.PI / 2]);

    this.tcp = new THREE.Object3D();
    this.tcp.name = 'TCP';
    this.tcp.position.set(0, 0, 0.35);
    j6.add(this.tcp);
    this.tcpRef = this.tcp;
    this.root.updateMatrixWorld(true);
  };
  RobotRig.prototype.buildHose = function () {
    this.hoseGroup = new THREE.Group();
    this.hoseGroup.name = 'Hose';
    this.scene.add(this.hoseGroup);
    const mat = new THREE.MeshStandardMaterial({ color: 0x20262f, roughness: 0.82, metalness: 0.08 });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.hoseMesh = mesh;
    this.hoseGroup.add(mesh);
    this._hoseStartLocal = new THREE.Vector3(0.16, 0.8, -0.28);
    this.updateHose(true);
  };

  RobotRig.prototype.updateHose = function (force) {
    if (!this.hoseMesh) return;
    this.root.updateMatrixWorld(true);
    const start = this.root.localToWorld(this._hoseStartLocal.clone());
    const tcp = this.getTCP();
    const end = tcp.position.clone().addScaledVector(tcp.direction, -0.05);
    if (!force && this._hoseLastEnd && this._hoseLastEnd.distanceTo(end) < 0.012) return;
    this._hoseLastEnd = end.clone();
    const mid = start.clone().lerp(end, 0.5);
    mid.y -= 0.22;
    const q1 = start.clone().lerp(mid, 0.55);
    q1.y -= 0.06;
    q1.x += 0.12;
    const q2 = mid.clone().lerp(end, 0.55);
    q2.y -= 0.02;
    q2.z += 0.06;
    const curve = new THREE.CatmullRomCurve3([start, q1, mid, q2, end], false, 'catmullrom', 0.4);
    const geo = new THREE.TubeGeometry(curve, 36, 0.021, 7, false);
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
    this.updateHose(true);
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
      const p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
      this.jointGroups[1].getWorldPosition(p1);
      this.jointGroups[2].getWorldPosition(p2);
      pts.push(p1.clone().lerp(p2, 0.5));
      this.jointGroups[2].getWorldPosition(p1);
      this.jointGroups[3].getWorldPosition(p2);
      pts.push(p1.clone().lerp(p2, 0.5));
      this.jointGroups[3].getWorldPosition(p1);
      this.jointGroups[4].getWorldPosition(p2);
      pts.push(p1.clone().lerp(p2, 0.5));
    }
    return pts;
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

  RobotRig.prototype.update = function (dt) {
    this._hoseClock += dt;
    if (this._hoseClock > 0.09) {
      this._hoseClock = 0;
      this.updateHose(false);
    }
  };
  RobotRig.prototype.computeHomeJoints = function () {
    const target = new THREE.Vector3(this.basePos.x + 0.4, 1.45, this.basePos.z - 1.15);
    const sol = this.solveIK(target, new THREE.Vector3(0, 0, -1));
    if (sol && sol.angles.every((v) => isFinite(v))) return sol.angles;
    return [0, -35, 70, 0, -35, 0];
  };

  // 转运姿态：机械臂收拢在底盘上方，避免行驶时伸向墙面
  RobotRig.prototype.computeTransportJoints = function () {
    const target = new THREE.Vector3(this.basePos.x, 1.95, this.basePos.z + 0.1);
    const sol = this.solveIK(target, new THREE.Vector3(0, 0, -1), this.currentJoints);
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
    const base = new THREE.Vector3(this.basePos.x, 0, this.basePos.z);
    const shoulder = new THREE.Vector3(base.x, R.baseY + R.shoulderY, base.z);
    const L1 = R.L1, L2 = R.L2, L3 = R.L3;

    const wrist = P.clone().addScaledVector(D, -L3);
    const dx = wrist.x - base.x;
    const dz = wrist.z - base.z;
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
    const shoulder = new THREE.Vector3(this.basePos.x, R.baseY + R.shoulderY, this.basePos.z);
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