// ────────────────────────────────────────────────────────────────────────────
// dice3d.js — alles 3D-spezifische für die Würfel-Skins (Three.js).
//
// Architektur: EIN geteilter WebGLRenderer für alle Würfel-Instanzen.
// Browser erlauben nur ~8–16 WebGL-Contexts; die Skin-Sammlung kann aber bis
// zu 200 Mini-Previews zeigen. Deshalb rendert jede Instanz ihre Szene über
// den geteilten Renderer und blittet das Ergebnis per drawImage in ein
// eigenes 2D-Canvas. Ein IntersectionObserver pausiert unsichtbare Würfel.
//
// Exporte:
//   createDie3D(container, dieType, skinOrNull, options) → { scene, cleanup(), … }
//   rollDie3D(dieObj, targetValue, onComplete)           → Roll-Animation (1.2 s)
//   updateDieSkin(dieObj, skin)                          → Materialien live tauschen
// ────────────────────────────────────────────────────────────────────────────

import * as THREE from "three";
import { DICE_SIDES, SKIN_COLOR_HEX } from "./constants.js?v=2026-06-13-luck-3";

const DEFAULT_FACE_COLOR = "#2a2a2a";  // kein Skin aktiv → dunkelgrau, leicht metallisch
const ROLL_DURATION_MS   = 1200;
const MAX_BACKING_PX     = 640;        // Backing-Größe des geteilten Renderers

// ── Geteilter Renderer + Render-Loop ────────────────────────────────────────
let sharedRenderer = null;
let rendererFailed = false;
let rafId = null;
const instances = new Set();

const visObserver = (typeof IntersectionObserver !== "undefined")
  ? new IntersectionObserver((entries) => {
      for(const e of entries){
        const inst = e.target.__die3dInst;
        if(inst){
          inst.visible = e.isIntersecting;
          if(e.isIntersecting) inst.needsRender = true;
        }
      }
    })
  : null;

function getSharedRenderer(){
  if(sharedRenderer) return sharedRenderer;
  if(rendererFailed) return null;
  try{
    sharedRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    sharedRenderer.setClearColor(0x000000, 0);
    sharedRenderer.setSize(MAX_BACKING_PX, MAX_BACKING_PX, false);
    sharedRenderer.setScissorTest(true);
  }catch(_){
    rendererFailed = true;
    sharedRenderer = null;
  }
  return sharedRenderer;
}
function startLoop(){
  if(rafId === null && instances.size > 0) rafId = requestAnimationFrame(tick);
}
function stopLoopIfIdle(){
  if(instances.size === 0 && rafId !== null){
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}
function tick(now){
  rafId = null;
  for(const inst of instances) stepInstance(inst, now);
  if(instances.size > 0) rafId = requestAnimationFrame(tick);
}
// Schließt eine Roll-Animation ab: Endorientierung setzen, rendern, onComplete feuern.
// Wird vom rAF-Loop (normal) ODER vom Failsafe-Timer (Tab versteckt) aufgerufen —
// in versteckten Tabs pausiert Chrome requestAnimationFrame KOMPLETT, die Spiel-Logik
// hinter onComplete (Punkte, Online-Züge) muss aber trotzdem weiterlaufen.
function completeAnim(inst){
  const a = inst.anim;
  if(!a) return;
  if(a.failsafe){ clearTimeout(a.failsafe); a.failsafe = null; }
  inst.anim = null;
  inst.mesh.quaternion.copy(a.targetQ);
  renderInstance(inst);
  inst.needsRender = false;
  if(typeof a.onComplete === "function") a.onComplete();
}
function stepInstance(inst, now){
  // Unsichtbar UND keine laufende Animation → nichts tun. Eine laufende
  // Roll-Animation muss trotzdem zu Ende laufen (onComplete treibt Spiel-Logik).
  if(!inst.visible && !inst.anim) return;
  let dirty = inst.needsRender;
  if(inst.anim){
    const a = inst.anim;
    const p = Math.min(1, (now - a.start) / a.duration);
    const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic: schnell starten, abbremsen
    inst.mesh.quaternion
      .setFromAxisAngle(a.axis, a.totalAngle * eased)
      .multiply(a.startQ);
    dirty = true;
    if(p >= 1){
      completeAnim(inst);
      return;
    }
  } else if(inst.autoRotate && inst.visible){
    inst.mesh.rotation.y += inst.autoRotateSpeed;
    inst.mesh.rotation.x += inst.autoRotateSpeed * 0.35;
    dirty = true;
  }
  if(dirty && inst.visible){
    renderInstance(inst);
    inst.needsRender = false;
  }
}
function renderInstance(inst){
  const r = getSharedRenderer();
  if(!r) return;
  const px = inst.pixelSize;
  // GL-Viewport unten-links verankern → entspricht in 2D-Canvas-Koordinaten (0,0)..(px,px) oben.
  r.setViewport(0, MAX_BACKING_PX - px, px, px);
  r.setScissor(0, MAX_BACKING_PX - px, px, px);
  r.render(inst.scene, inst.camera);
  inst.ctx.clearRect(0, 0, px, px);
  inst.ctx.drawImage(r.domElement, 0, 0, px, px, 0, 0, px, px);
}

// ── Geometrien ──────────────────────────────────────────────────────────────
// Jede logische Würfelfläche bekommt eine eigene Material-Gruppe:
// Gruppe i ↔ Seitenwert i+1.
function groupPolyhedron(geo, trisPerFace){
  // PolyhedronGeometry ist non-indexed; je Fläche liegen trisPerFace Dreiecke
  // hintereinander im Positions-Buffer (d12: Pentagon = 3-er Fächer).
  geo.clearGroups();
  const faceCount = geo.attributes.position.count / 3 / trisPerFace;
  for(let f = 0; f < faceCount; f++){
    geo.addGroup(f * trisPerFace * 3, trisPerFace * 3, f);
  }
  return geo;
}
// d10: Dipyramide — 2 × 5-seitige Pyramide, an der 5-eckigen Basis gespiegelt.
function buildD10Geometry(){
  const R = 1.35, H = 1.5;
  const eq = [];
  for(let i = 0; i < 5; i++){
    const a = (i / 5) * Math.PI * 2;
    eq.push(new THREE.Vector3(Math.cos(a) * R, 0, Math.sin(a) * R));
  }
  const top = new THREE.Vector3(0, H, 0);
  const bot = new THREE.Vector3(0, -H, 0);
  const positions = [];
  const pushFace = (a, b, c) => {
    // Winding so fixen, dass die Normale nach außen zeigt (vom Zentrum weg).
    const n = new THREE.Vector3().subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a));
    const centroid = new THREE.Vector3().add(a).add(b).add(c).multiplyScalar(1 / 3);
    if(n.dot(centroid) < 0){ const t = b; b = c; c = t; }
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  for(let i = 0; i < 5; i++) pushFace(top, eq[i], eq[(i + 1) % 5]);   // Flächen 1–5
  for(let i = 0; i < 5; i++) pushFace(bot, eq[(i + 1) % 5], eq[i]);   // Flächen 6–10
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 2).fill(0), 2));
  geo.computeVertexNormals();
  return groupPolyhedron(geo, 1);
}
function buildGeometry(dieType){
  switch(dieType){
    case "d4":  return groupPolyhedron(new THREE.TetrahedronGeometry(1.7), 1);
    case "d6":  return new THREE.BoxGeometry(1.85, 1.85, 1.85); // 6 Gruppen built-in
    case "d8":  return groupPolyhedron(new THREE.OctahedronGeometry(1.55), 1);
    case "d10": return buildD10Geometry();
    case "d12": return groupPolyhedron(new THREE.DodecahedronGeometry(1.45), 3);
    case "d20": return groupPolyhedron(new THREE.IcosahedronGeometry(1.55), 1);
    default:    return new THREE.BoxGeometry(1.85, 1.85, 1.85);
  }
}
// Pro Fläche die Außen-Normale bestimmen (aus dem ersten Dreieck der Gruppe).
// Wird für die "Zielwert oben"-Endrotation des Wurfs gebraucht.
function extractFaceNormals(geo){
  const pos = geo.attributes.position;
  const idx = geo.index;
  const normals = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for(const g of geo.groups){
    const vi = [0, 1, 2].map(k => idx ? idx.getX(g.start + k) : (g.start + k));
    a.fromBufferAttribute(pos, vi[0]);
    b.fromBufferAttribute(pos, vi[1]);
    c.fromBufferAttribute(pos, vi[2]);
    const n = new THREE.Vector3().subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a)).normalize();
    normals[g.materialIndex] = n;
  }
  return normals;
}
// UVs pro Fläche neu setzen: Vertices auf die Flächenebene projizieren und
// um den Flächen-Schwerpunkt zentrieren → die Zahl der Canvas-Texture landet
// mittig auf der Fläche. (BoxGeometry behält ihre Standard-UVs.)
function assignFaceUVs(geo){
  if(geo.index) return; // Box → UVs sind bereits korrekt pro Fläche
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const v = new THREE.Vector3();
  for(const g of geo.groups){
    const centroid = new THREE.Vector3();
    for(let i = 0; i < g.count; i++){
      v.fromBufferAttribute(pos, g.start + i);
      centroid.add(v);
    }
    centroid.multiplyScalar(1 / g.count);
    const a = new THREE.Vector3().fromBufferAttribute(pos, g.start);
    const b = new THREE.Vector3().fromBufferAttribute(pos, g.start + 1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, g.start + 2);
    const n = new THREE.Vector3().subVectors(b, a)
      .cross(new THREE.Vector3().subVectors(c, a)).normalize();
    const helper = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const t = new THREE.Vector3().crossVectors(helper, n).normalize();
    const bt = new THREE.Vector3().crossVectors(n, t).normalize();
    const proj = [];
    let maxE = 0;
    for(let i = 0; i < g.count; i++){
      v.fromBufferAttribute(pos, g.start + i).sub(centroid);
      const px = v.dot(t), py = v.dot(bt);
      proj.push([px, py]);
      maxE = Math.max(maxE, Math.abs(px), Math.abs(py));
    }
    const s = maxE > 0 ? 0.46 / maxE : 1;
    for(let i = 0; i < g.count; i++){
      uv.setXY(g.start + i, 0.5 + proj[i][0] * s, 0.5 + proj[i][1] * s);
    }
  }
  uv.needsUpdate = true;
}

// ── Materialien / Texturen ──────────────────────────────────────────────────
// Auf Dreiecks-Flächen muss die Zahl kleiner sein als auf Quadraten/Pentagonen,
// damit sie innerhalb der Fläche bleibt.
const NUMBER_SCALE = { d4: 0.30, d6: 0.46, d8: 0.30, d10: 0.28, d12: 0.36, d20: 0.26 };

function faceColorHex(skin, faceIndex){
  if(skin && Array.isArray(skin.faces)){
    const hex = SKIN_COLOR_HEX[skin.faces[faceIndex]];
    if(hex) return hex;
  }
  return DEFAULT_FACE_COLOR;
}
function makeFaceTexture(value, colorHex, numberScale, texSize){
  const size = texSize || 128;
  const cnv = document.createElement("canvas");
  cnv.width = cnv.height = size;
  const ctx = cnv.getContext("2d");
  ctx.fillStyle = colorHex;
  ctx.fillRect(0, 0, size, size);
  // Weiße Zahl mit dunkler Kontur (lesbar auch auf Gelb)
  const fs = Math.round(size * numberScale * 1.55);
  ctx.font = "900 " + fs + "px Inter, 'Segoe UI', Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(2, size * 0.04);
  ctx.strokeStyle = "rgba(0,0,0,0.40)";
  ctx.strokeText(String(value), size / 2, size / 2 + size * 0.03);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(String(value), size / 2, size / 2 + size * 0.03);
  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
function makeFaceMaterial(value, colorHex, numberScale, texSize){
  return new THREE.MeshStandardMaterial({
    map: makeFaceTexture(value, colorHex, numberScale, texSize),
    metalness: colorHex === DEFAULT_FACE_COLOR ? 0.55 : 0.25,
    roughness: 0.38,
  });
}

// ── Public API ──────────────────────────────────────────────────────────────
/**
 * Erstellt einen 3D-Würfel im Container.
 * @param {HTMLElement} container
 * @param {string} dieType           "d4" … "d20"
 * @param {object|null} skinOrNull   Skin-Objekt ({ faces: [...] }) oder null
 * @param {object} options           { size=200, autoRotate=false, autoRotateSpeed, textureSize }
 * @returns {object|null}            dieObj mit { scene, cleanup() } — null wenn WebGL fehlt
 */
export function createDie3D(container, dieType, skinOrNull, options){
  const opts = options || {};
  if(!getSharedRenderer()) return null;

  const size = opts.size || 200;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.min(Math.round(size * dpr), MAX_BACKING_PX);
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = size + "px";
  canvas.style.height = size + "px";
  canvas.className = "die3dCanvas";
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 2.5, 4.7);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
  dirLight.position.set(3, 5, 4); // oben-rechts
  scene.add(dirLight);
  const underGlow = new THREE.PointLight(0xffffff, 0.3, 0, 0); // decay 0 → wirkt wie Legacy-Füll-Licht
  underGlow.position.set(0, -3, 0);
  scene.add(underGlow);

  const sides = DICE_SIDES[dieType] || 6;
  const geo = buildGeometry(dieType);
  assignFaceUVs(geo);
  const faceNormals = extractFaceNormals(geo);
  const numScale = NUMBER_SCALE[dieType] || 0.3;
  const texSize = opts.textureSize || 128;
  const materials = [];
  for(let i = 0; i < sides; i++){
    materials.push(makeFaceMaterial(i + 1, faceColorHex(skinOrNull, i), numScale, texSize));
  }
  const mesh = new THREE.Mesh(geo, materials);
  // Start-Orientierung: höchste Seite leicht zur Kamera geneigt
  mesh.quaternion.setFromUnitVectors(
    faceNormals[sides - 1],
    new THREE.Vector3(0, 0.65, 1).normalize()
  );
  scene.add(mesh);

  const inst = {
    scene, camera, mesh, dieType, skin: skinOrNull || null,
    faceNormals,
    canvas, ctx: canvas.getContext("2d"), pixelSize: px,
    numScale, texSize,
    autoRotate: !!opts.autoRotate,
    autoRotateSpeed: opts.autoRotateSpeed || 0.012,
    anim: null,
    visible: true,
    needsRender: true,
    cleanup(){
      if(inst.anim && inst.anim.failsafe){ clearTimeout(inst.anim.failsafe); }
      inst.anim = null;
      instances.delete(inst);
      if(visObserver) visObserver.unobserve(canvas);
      geo.dispose();
      for(const m of materials){
        if(m.map) m.map.dispose();
        m.dispose();
      }
      if(canvas.parentNode) canvas.parentNode.removeChild(canvas);
      // Letzter Würfel weg → Loop stoppen und den geteilten GL-Context freigeben.
      stopLoopIfIdle();
      if(instances.size === 0 && sharedRenderer){
        sharedRenderer.dispose();
        sharedRenderer = null;
      }
    },
  };
  canvas.__die3dInst = inst;
  if(visObserver) visObserver.observe(canvas);
  instances.add(inst);
  startLoop();
  return inst;
}

/**
 * Roll-Animation: 1.2 s, erst schnell, dann abbremsen; endet mit targetValue
 * exakt nach oben zeigend (gilt für alle Würfeltypen, nicht nur d6).
 */
export function rollDie3D(dieObj, targetValue, onComplete){
  if(!dieObj || !dieObj.mesh){ if(typeof onComplete === "function") onComplete(); return; }
  const sides = DICE_SIDES[dieObj.dieType] || 6;
  const v = Math.min(Math.max(1, Math.floor(targetValue) || 1), sides);
  const up = new THREE.Vector3(0, 1, 0);
  const targetQ = new THREE.Quaternion().setFromUnitVectors(dieObj.faceNormals[v - 1], up);

  // Delta von aktueller Orientierung → Ziel, als Achse+Winkel, plus 2–3 Extra-Umdrehungen.
  const startQ = dieObj.mesh.quaternion.clone();
  const qd = targetQ.clone().multiply(startQ.clone().invert());
  if(qd.w < 0){ qd.x *= -1; qd.y *= -1; qd.z *= -1; qd.w *= -1; } // kurzer Weg
  let angle = 2 * Math.acos(Math.min(1, qd.w));
  const s = Math.sqrt(Math.max(0, 1 - qd.w * qd.w));
  let axis;
  if(s < 1e-4){
    axis = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
    angle = 0;
  } else {
    axis = new THREE.Vector3(qd.x / s, qd.y / s, qd.z / s);
  }
  // Eine evtl. noch laufende Animation sauber verwerfen (inkl. ihres Failsafes),
  // damit deren onComplete nicht später fälschlich feuert.
  if(dieObj.anim && dieObj.anim.failsafe) clearTimeout(dieObj.anim.failsafe);
  const spins = 2 + Math.floor(Math.random() * 2);
  const anim = {
    startQ, targetQ, axis,
    totalAngle: angle + spins * Math.PI * 2,
    start: performance.now(),
    duration: ROLL_DURATION_MS,
    onComplete,
    failsafe: null,
  };
  dieObj.anim = anim;
  // Failsafe: feuert, falls der rAF-Loop die Animation nicht abschließt (Tab hidden).
  // setTimeout läuft in versteckten Tabs gedrosselt, aber zuverlässig weiter.
  anim.failsafe = setTimeout(() => {
    if(dieObj.anim === anim) completeAnim(dieObj);
  }, ROLL_DURATION_MS + 250);
  dieObj.autoRotate = false; // während des Wurfs keine Auto-Rotation
  startLoop();
}

/** Tauscht die Flächen-Farben live aus (skin = null → zurück auf Dunkelgrau). */
export function updateDieSkin(dieObj, skin){
  if(!dieObj || !dieObj.mesh) return;
  dieObj.skin = skin || null;
  const mats = dieObj.mesh.material;
  for(let i = 0; i < mats.length; i++){
    const hex = faceColorHex(skin, i);
    const old = mats[i].map;
    mats[i].map = makeFaceTexture(i + 1, hex, dieObj.numScale, dieObj.texSize);
    mats[i].metalness = hex === DEFAULT_FACE_COLOR ? 0.55 : 0.25;
    mats[i].needsUpdate = true;
    if(old) old.dispose();
  }
  dieObj.needsRender = true;
}
