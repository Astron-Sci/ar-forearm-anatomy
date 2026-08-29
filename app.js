// app.js - 前臂与手部 AR 解剖调试版 v0.1
// 全新架构：MediaPipe Hands(21点) + Three.js GLB 模型 + 动作识别联动肌肉高亮
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = id => document.getElementById(id);
const show = id => $(id).classList.remove('hidden');
const hide = id => $(id).classList.add('hidden');

const state = {
  running: false,
  showBones: true,
  showMuscles: true,
  highlight: true,
  hand: null,           // 当前手部关键点
  handedness: null,     // Left / Right
  landmarks: null,      // 归一化 21 点
  score: 0,
  actions: [],          // 识别出的动作列表
};

// ── Three.js 场景 ──
let scene, camera, renderer, modelRoot;
let bonesGroup, musclesGroup;
const boneMeshes = new Map();    // name -> THREE.Mesh
const muscleMeshes = new Map();  // name -> THREE.Mesh
let camFacingFront = true;

function initThree() {
  const c = $('three-container');
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, c.clientWidth / c.clientHeight, 0.01, 100);
  camera.position.set(0, 0, 1.2);
  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(c.clientWidth, c.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  c.appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const d1 = new THREE.DirectionalLight(0xffffff, 1.2); d1.position.set(1, 2, 2); scene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.4); d2.position.set(-1, -1, -1); scene.add(d2);
  window.addEventListener('resize', () => {
    camera.aspect = c.clientWidth / c.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(c.clientWidth, c.clientHeight);
  });
}

async function loadModels() {
  const loader = new GLTFLoader();
  let b, m;
  try {
    const r = await Promise.all([
      loader.loadAsync('forearm_bones.glb'),
      loader.loadAsync('forearm_muscles.glb'),
    ]);
    b = r[0]; m = r[1];
    console.log('[load] bones.scene:', b.scene ? 'defined' : 'UNDEFINED', '| muscles.scene:', m.scene ? 'defined' : 'UNDEFINED');
    if (!b.scene) throw new Error('bones GLB 没有 scene (scene.nodes 为空?)');
    if (!m.scene) throw new Error('muscles GLB 没有 scene');
  } catch (e) {
    console.error('[load] fetch/parse error:', e.message);
    throw e;
  }
  bonesGroup = new THREE.Group();
  musclesGroup = new THREE.Group();

  // 注意：不能在 traverse 回调里直接 add 到别的组（会修改正在遍历的 children 数组）
  // 先收集，再统一添加
  const collectBones = [];
  b.scene.traverse(o => { if (o.isMesh) collectBones.push(o); });
  const collectMuscles = [];
  m.scene.traverse(o => { if (o.isMesh) collectMuscles.push(o); });
  console.log('[load] bones meshes:', collectBones.length, '| muscles meshes:', collectMuscles.length);

  // 先把所有 mesh 挂到一个临时组，计算整体包围盒
  const tmpAll = new THREE.Group();
  collectBones.forEach(o => tmpAll.add(o));
  collectMuscles.forEach(o => tmpAll.add(o));
  const boxAll = new THREE.Box3().setFromObject(tmpAll);
  const centerAll = boxAll.getCenter(new THREE.Vector3());
  const sizeAll = boxAll.getSize(new THREE.Vector3());
  const scaleAll = 0.55 / Math.max(sizeAll.x, sizeAll.y, sizeAll.z);
  console.log('[load] box center:', centerAll.toArray().map(n=>n.toFixed(1)).join(','), '| size:', sizeAll.toArray().map(n=>n.toFixed(1)).join(','), '| scale:', scaleAll.toFixed(4));

  // 把居中+缩放直接烘焙进 geometry（modelRoot 永远保持原点、单位缩放）
  collectBones.forEach(o => {
    o.name = o.name.replace(/_/g, ' ');
    o.geometry.translate(-centerAll.x, -centerAll.y, -centerAll.z);
    o.geometry.scale(scaleAll, scaleAll, scaleAll);
    o.material = new THREE.MeshPhongMaterial({
      color: 0xf0ead6, emissive: 0x888866, emissiveIntensity: 0.08,
      transparent: true, opacity: 0.99, shininess: 30, side: THREE.DoubleSide,
    });
    o.castShadow = false;
    bonesGroup.add(o);
    boneMeshes.set(o.name, o);
  });
  collectMuscles.forEach(o => {
    o.name = o.name.replace(/_/g, ' ');
    o.geometry.translate(-centerAll.x, -centerAll.y, -centerAll.z);
    o.geometry.scale(scaleAll, scaleAll, scaleAll);
    o.material = new THREE.MeshPhongMaterial({
      color: 0xcc5544, emissive: 0x552222, emissiveIntensity: 0.08,
      transparent: true, opacity: 0.85, shininess: 20, side: THREE.DoubleSide,
    });
    musclesGroup.add(o);
    muscleMeshes.set(o.name, o);
  });

  modelRoot = new THREE.Group();
  modelRoot.add(bonesGroup);
  modelRoot.add(musclesGroup);
  // 模型已烘焙到原点附近，modelRoot 保持单位变换
  modelRoot.position.set(0, 0, 0);
  modelRoot.scale.set(1, 1, 1);

  scene.add(modelRoot);
  applyLayerVisibility();
  setStatus('模型加载完成');
}

// ── 图层控制 ──
function applyLayerVisibility() {
  if (bonesGroup) bonesGroup.visible = state.showBones;
  if (musclesGroup) musclesGroup.visible = state.showMuscles;
}

// ── 肌肉联动高亮 ──
// 每个动作 → 参与的肌肉名列表（与 GLB 节点名精确匹配）
const ACTION_MUSCLES = {
  '握拳': ['left flexor digitorum superficialis', 'left flexor digitorum superficialis (2)', 'left flexor digitorum profundus', 'set of lumbricals of left hand'],
  '伸指': ['left extensor digitorum', 'left extensor indicis', 'left extensor digiti minimi'],
  '屈腕': ['left flexor carpi radialis', 'left flexor carpi ulnaris', 'humeral head of left flexor carpi ulnaris', 'ulnar head of left flexor carpi ulnaris', 'left palmaris longus'],
  '伸腕': ['left extensor carpi radialis longus', 'left extensor carpi radialis brevis', 'left extensor carpi ulnaris', 'left extensor carpi ulnaris (2)'],
  '拇指屈': ['left flexor pollicis longus', 'left flexor pollicis brevis', 'superficial head of left flexor pollicis brevis'],
  '拇指伸': ['left extensor pollicis longus', 'left extensor pollicis brevis'],
  '拇指对掌': ['left opponens pollicis', 'left abductor pollicis brevis'],
  '旋前': ['left pronator teres', 'humeral head of left pronator teres', 'ulnar head of left pronator teres', 'left pronator quadratus'],
  '旋后': ['left supinator', 'left brachioradialis'],
};

const HIGHLIGHT_COLOR = 0xffd54f;   // 高亮金色
const MUSCLE_BASE = 0xcc5544;
const HIGHLIGHT_OPACITY = 0.95;

function applyHighlight() {
  if (!musclesGroup) return;
  const active = new Set();
  state.actions.forEach(a => {
    (ACTION_MUSCLES[a] || []).forEach(n => active.add(n));
  });
  muscleMeshes.forEach((mesh, name) => {
    if (!state.highlight) {
      mesh.material.color.setHex(MUSCLE_BASE);
      mesh.material.opacity = 0.65;
      mesh.material.emissive.setHex(0x552222);
      return;
    }
    const on = active.has(name);
    mesh.material.color.setHex(on ? HIGHLIGHT_COLOR : MUSCLE_BASE);
    mesh.material.opacity = on ? HIGHLIGHT_OPACITY : 0.55;
    mesh.material.emissive.setHex(on ? 0x664400 : 0x552222);
  });
}

// ── 动作识别 ──
// 基于 21 点手部关键点（MediaPipe Hands 标准索引）
// 拇指: 1-4, 食指: 5-8, 中指: 9-12, 无名指: 13-16, 小指: 17-20, 腕: 0
function fingerCurl(lm, a, b, c, d) {
  // 计算 PIP(中间关节) 弯曲角：向量 ba 与 bc 的夹角
  const v1 = { x: lm[a].x - lm[b].x, y: lm[a].y - lm[b].y, z: lm[a].z - lm[b].z };
  const v2 = { x: lm[c].x - lm[b].x, y: lm[c].y - lm[b].y, z: lm[c].z - lm[b].z };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const l1 = Math.hypot(v1.x, v1.y, v1.z), l2 = Math.hypot(v2.x, v2.y, v2.z);
  if (l1 < 1e-6 || l2 < 1e-6) return 0;
  const ang = Math.acos(Math.max(-1, Math.min(1, dot / (l1 * l2))));
  return ang * 180 / Math.PI;  // 0=伸直, 180=完全弯曲
}
function thumbCurl(lm) {
  // 拇指用 CMC-MCP 段与 MCP-IP 段夹角近似
  const v1 = { x: lm[1].x - lm[2].x, y: lm[1].y - lm[2].y, z: lm[1].z - lm[2].z };
  const v2 = { x: lm[3].x - lm[2].x, y: lm[3].y - lm[2].y, z: lm[3].z - lm[2].z };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const l1 = Math.hypot(v1.x, v1.y, v1.z), l2 = Math.hypot(v2.x, v2.y, v2.z);
  if (l1 < 1e-6 || l2 < 1e-6) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / (l1 * l2)))) * 180 / Math.PI;
}
function wristAngle(lm) {
  // 腕部弯曲：手腕(0) - 中指MCP(9) 方向 vs 中指MCP(9) - 中指PIP(10) 方向
  const v1 = { x: lm[0].x - lm[9].x, y: lm[0].y - lm[9].y, z: lm[0].z - lm[9].z };
  const v2 = { x: lm[10].x - lm[9].x, y: lm[10].y - lm[9].y, z: lm[10].z - lm[9].z };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const l1 = Math.hypot(v1.x, v1.y, v1.z), l2 = Math.hypot(v2.x, v2.y, v2.z);
  if (l1 < 1e-6 || l2 < 1e-6) return 90;
  return Math.acos(Math.max(-1, Math.min(1, dot / (l1 * l2)))) * 180 / Math.PI;
}

function analyzeActions(lm) {
  const actions = [];
  // 四指弯曲（食中无名小）
  const curls = [
    fingerCurl(lm, 5, 6, 7, 8),
    fingerCurl(lm, 9, 10, 11, 12),
    fingerCurl(lm, 13, 14, 15, 16),
    fingerCurl(lm, 17, 18, 19, 20),
  ];
  const avgCurl = curls.reduce((a, b) => a + b, 0) / 4;
  const tCurl = thumbCurl(lm);
  const wAng = wristAngle(lm);

  if (avgCurl > 100) actions.push('握拳');
  else if (avgCurl < 40) actions.push('伸指');
  if (tCurl > 90) actions.push('拇指屈');
  else if (tCurl < 35) actions.push('拇指伸');
  // 拇指对掌：拇指尖(4) 与小指尖(20) 距离近
  const dThumbPinky = Math.hypot(lm[4].x - lm[20].x, lm[4].y - lm[20].y, lm[4].z - lm[20].z);
  if (dThumbPinky < 0.12 && avgCurl > 60) actions.push('拇指对掌');
  if (wAng < 60) actions.push('屈腕');
  else if (wAng > 130) actions.push('伸腕');

  // 调试显示
  $('dbg-curl').textContent = avgCurl.toFixed(0) + '°';
  $('dbg-thumb').textContent = tCurl.toFixed(0) + '°';
  $('dbg-wrist').textContent = wAng.toFixed(0) + '°';
  return actions;
}

// ── 模型跟随手部 ──
function updateModelFromHand(lm) {
  if (!modelRoot) return;
  // 以手掌中心(腕0 + 中指MCP 9)为锚点，映射到屏幕坐标（视频为上下翻转的前置镜像）
  const wx = (lm[0].x + lm[9].x) / 2;
  const wy = (lm[0].y + lm[9].y) / 2;
  // 前置摄像头画面是镜像的：x 取反
  let nx = camFacingFront ? (1 - wx) : wx;
  let ny = wy;
  // 屏幕坐标 → NDC
  const ndcX = nx * 2 - 1;
  const ndcY = -(ny * 2 - 1);
  const v = new THREE.Vector3(ndcX, ndcY, -1).unproject(camera);
  const dir = v.sub(camera.position).normalize();
  const dist = 1.2;
  const pos = camera.position.clone().add(dir.multiplyScalar(dist));
  modelRoot.position.set(pos.x, pos.y, pos.z);

  // 手部大小 → 模型缩放（模型已烘焙到宽约 0.55 世界单位）
  // handW 是手在画面中的归一化宽度(0-1)，映射为模型比例
  const handW = Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) * 2;
  // 当手占画面约 30% 宽时，模型约等于手的大小；线性映射并限制范围
  const targetScale = Math.max(0.5, Math.min(4.0, handW * 2.6));
  modelRoot.scale.setScalar(targetScale);

  // 朝向：根据掌面法线粗略旋转（绕Z轴跟随手掌方向）
  const ang = Math.atan2(lm[9].y - lm[0].y, lm[9].x - lm[0].x);
  modelRoot.rotation.z = camFacingFront ? -ang : ang;
}

// ── MediaPipe Hands ──
let handsInst = null, camStream = null, frameLoop = true;

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('加载失败: ' + src));
    document.head.appendChild(s);
  });
}

async function initHands() {
  if (typeof window.Hands !== 'undefined') return;
  await loadScript('https://unpkg.com/@mediapipe/hands/hands.js');
  await loadScript('https://unpkg.com/@mediapipe/camera_utils/camera_utils.js');
}

async function startCamera() {
  try {
    const constraints = camFacingFront
      ? { video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } }
      : { video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } } };
    camStream = await navigator.mediaDevices.getUserMedia(constraints);
    const video = $('video');
    video.srcObject = camStream;
    await video.play();
    // 前置摄像头镜像
    video.style.transform = camFacingFront ? 'scaleX(-1)' : 'scaleX(1)';

    handsInst = new window.Hands({ locateFile: f => 'https://unpkg.com/@mediapipe/hands/' + f });
    handsInst.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    handsInst.onResults(onHandResults);

    frameLoop = true;
    async function loop() {
      if (!frameLoop) return;
      if (video.readyState >= 2) {
        try { await handsInst.send({ image: video }); } catch (e) { /* 单帧失败忽略 */ }
      }
      requestAnimationFrame(loop);
    }
    loop();
    setStatus('识别中… 把手放到摄像头前');
  } catch (e) {
    setStatus('摄像头错误: ' + (e.name === 'NotAllowedError' ? '请允许摄像头权限' : e.message));
  }
}

function onHandResults(r) {
  if (!r || !r.multiHandLandmarks || r.multiHandLandmarks.length === 0) {
    state.hand = null;
    $('dbg-status').textContent = '未检测到手';
    $('dbg-score').textContent = '-';
    state.actions = [];
    applyHighlight();
    return;
  }
  state.hand = r.multiHandLandmarks[0];
  state.landmarks = state.hand;
  state.handedness = r.multiHandedness && r.multiHandedness[0] ? r.multiHandedness[0].label : '?';
  state.score = (r.multiHandedness && r.multiHandedness[0] ? r.multiHandedness[0].score : 0);

  $('dbg-status').textContent = `✓ ${state.handedness}手`;
  $('dbg-score').textContent = state.score.toFixed(2);

  state.actions = analyzeActions(state.hand);
  $('dbg-action').textContent = state.actions.length ? state.actions.join('、') : '无';
  const mus = new Set();
  state.actions.forEach(a => (ACTION_MUSCLES[a] || []).forEach(n => mus.add(n)));
  $('dbg-muscles').textContent = mus.size ? mus.size + ' 块' : '-';
  applyHighlight();
  if (modelRoot) updateModelFromHand(state.hand);
}

// ── UI ──
function setStatus(m) {
  $('dbg-status').textContent = m;
}
function toast(m, ms = 2200) {
  const t = $('toast');
  t.textContent = m;
  show('toast');
  setTimeout(() => hide('toast'), ms);
}

function bindUI() {
  $('btn-start').addEventListener('click', async () => {
    hide('start-overlay');
    show('controls');
    try {
      await initHands();
      await startCamera();
      await loadModels();
      animate();
      state.running = true;
    } catch (e) {
      toast('启动失败: ' + e.message, 4000);
      console.error(e);
    }
  });
  $('btn-manual').addEventListener('click', async () => {
    hide('start-overlay');
    show('controls');
    try {
      await loadModels();
      if (camStream) camStream.getTracks().forEach(t => t.stop());
      frameLoop = false;
      // 手动模式：模型居中展示，可旋转（加轨道控制）
      if (!state.orbitAdded) {
        const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
        const c = $('three-container');
        c.style.pointerEvents = 'auto';
        state.orbit = new OrbitControls(camera, c);
        state.orbit.enableDamping = true;
        state.orbit.target.set(0, 0, 0);
        state.orbitAdded = true;
      }
      state.orbit.enabled = true;
      modelRoot.position.set(0, 0, 0);
      modelRoot.scale.set(1, 1, 1);
      modelRoot.rotation.set(0, 0, 0);
      camera.position.set(0, 0, 1.2);
      animate();
      toast('手动查看模式：拖动旋转 / 滚轮缩放');
    } catch (e) {
      toast('加载失败: ' + e.message, 4000);
      console.error(e);
    }
  });
  $('btn-bones').addEventListener('click', () => {
    state.showBones = !state.showBones;
    $('btn-bones').classList.toggle('active', state.showBones);
    applyLayerVisibility();
  });
  $('btn-muscles').addEventListener('click', () => {
    state.showMuscles = !state.showMuscles;
    $('btn-muscles').classList.toggle('active', state.showMuscles);
    applyLayerVisibility();
  });
  $('btn-highlight').addEventListener('click', () => {
    state.highlight = !state.highlight;
    $('btn-highlight').classList.toggle('active', state.highlight);
    applyHighlight();
  });
  $('btn-cam').addEventListener('click', async () => {
    camFacingFront = !camFacingFront;
    if (camStream) camStream.getTracks().forEach(t => t.stop());
    if (handsInst) { try { handsInst.close && handsInst.close(); } catch (e) {} handsInst = null; }
    await startCamera();
  });
  $('btn-collapse').addEventListener('click', () => {
    const body = $('dbg-body');
    const hidden = body.classList.toggle('hidden');
    $('btn-collapse').textContent = hidden ? '+' : '—';
  });
}

function animate() {
  requestAnimationFrame(animate);
  if (renderer && scene && camera) renderer.render(scene, camera);
}

// ── 启动 ──
initThree();
animate();  // 渲染循环立即启动
bindUI();
// 暴露给调试工具
window.__ar = { get scene() { return scene; }, get modelRoot() { return modelRoot; }, get bonesGroup() { return bonesGroup; }, get musclesGroup() { return musclesGroup; }, get state() { return state; } };

// 演示模式：?demo=1 自动进入手动查看（无需摄像头，供测试/预览）
if (new URLSearchParams(location.search).get('demo') === '1') {
  setTimeout(() => $('btn-manual').click(), 300);
}

// 自检：把渲染统计写到 DOM（供 headless 验证）
setInterval(() => {
  const el = document.getElementById('dbg-status');
  if (el && window.__ar) {
    const ar = window.__ar;
    const r = renderer && renderer.info ? renderer.info.render : null;
    const cam = camera ? 'cam:' + camera.position.toArray().map(n=>n.toFixed(2)).join(',') : '';
    const root = modelRoot ? 'root:' + modelRoot.position.toArray().map(n=>n.toFixed(2)).join(',') + ' s:' + (modelRoot.scale ? modelRoot.scale.x.toFixed(3) : '?') : 'noroot';
    el.textContent = '模型:' + (r ? r.triangles + 'tri ' + r.calls + 'calls' : '?') + ' | ' + cam + ' | ' + root;
  }
}, 1000);
