// Brimstead stage v2: the Tripo stoneware jar (web/models/vessel.glb, meshopt + webp, rim retinted to kiln orange),
// procedural lathe jar as fallback. Procedural, animated: cobalt liquid (shader), orange brim line, orange stream +
// droplets into the buyer's cup. Studio light: RoomEnvironment PMREM + warm key (soft shadow) + rim light + a shadow
// catcher and a baked contact shadow. No bloom, no grain. Rendering pauses when hidden or off screen.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const COBALT = new THREE.Color('#2340D8');
const COBALT_DEEP = new THREE.Color('#14249a');
const HOT = new THREE.Color('#FF5B1F');
const H = 2.0; // jar height in world units (base at y = 0)

// ───────────── profiles ─────────────
// Tripo jar: inner wall radius by height, measured from the mesh (model units, height −0.5..0.5), scaled ×2 here.
const TRIPO_INNER = [
  [-0.19, 0.2], [-0.138, 0.25], [-0.112, 0.282], [-0.063, 0.307], [-0.013, 0.326], [0.037, 0.337], [0.088, 0.342],
  [0.137, 0.342], [0.188, 0.337], [0.238, 0.325], [0.287, 0.309], [0.338, 0.295], [0.363, 0.287], [0.412, 0.285],
  [0.463, 0.297], [0.5, 0.316],
].map(([y, r]) => [(y + 0.5) * 2, r * 2]);
// outer surface radius (model units), measured the same way; used to cut the scan's inner wall away in the shader
const TRIPO_OUTER = [
  [-0.5, 0.25], [-0.438, 0.264], [-0.263, 0.376], [-0.162, 0.426], [-0.088, 0.452], [-0.037, 0.47], [0.012, 0.476],
  [0.063, 0.481], [0.113, 0.479], [0.262, 0.433], [0.313, 0.396], [0.387, 0.321], [0.438, 0.328], [0.5, 0.342],
];
const TRIPO_INNER_M = TRIPO_INNER.map(([y, r]) => [y / 2 - 0.5, r / 2]);
const glslLerp = (name, tbl) => {
  let c = `float ${name}(float y) {\n`;
  for (let i = 1; i < tbl.length; i++) {
    const [y0, r0] = tbl[i - 1], [y1, r1] = tbl[i];
    c += `  if (y <= ${y1.toFixed(4)}) return mix(${r0.toFixed(4)}, ${r1.toFixed(4)}, clamp((y - ${y0.toFixed(4)}) / ${(y1 - y0).toFixed(4)}, 0.0, 1.0));\n`;
  }
  return c + `  return ${tbl[tbl.length - 1][1].toFixed(4)};\n}\n`;
};
const CUT_GLSL = glslLerp('brimInner', TRIPO_INNER_M) + glslLerp('brimOuter', TRIPO_OUTER);

const TRIPO = { floor: 0.7, // just above the scanned inner floor
   lipR: 0.66, lipInner: 0.6, inner: (y) => interp(TRIPO_INNER, y) };

function interp(tbl, y) {
  if (y <= tbl[0][0]) return tbl[0][1];
  for (let i = 1; i < tbl.length; i++) if (y <= tbl[i][0]) {
    const [y0, r0] = tbl[i - 1], [y1, r1] = tbl[i];
    return r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
  }
  return tbl[tbl.length - 1][1];
}

// procedural fallback profile
const WALL = 0.075, FLOOR = 0.16;
const KEYS = [[0.0, 0.5], [0.06, 0.56], [0.3, 0.8], [0.8, 0.98], [1.25, 0.95], [1.62, 0.8], [1.86, 0.7], [2.0, 0.77]];
function outerR(y) {
  y = Math.min(H, Math.max(0, y));
  let i = 0;
  while (i < KEYS.length - 2 && y > KEYS[i + 1][0]) i++;
  const p0 = KEYS[Math.max(0, i - 1)], p1 = KEYS[i], p2 = KEYS[i + 1], p3 = KEYS[Math.min(KEYS.length - 1, i + 2)];
  const t = (y - p1[0]) / (p2[0] - p1[0]), t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
}
const PROC = { floor: FLOOR, lipR: outerR(H) - WALL * 0.5, lipInner: outerR(H) - WALL, inner: (y) => Math.max(0.05, outerR(y) - WALL) };

function vesselGeometry(seg) {
  const pts = [new THREE.Vector2(0.0001, 0), new THREE.Vector2(0.46, 0)];
  const N = 48;
  for (let i = 1; i <= N; i++) { const y = (i / N) * H; pts.push(new THREE.Vector2(outerR(y), y)); }
  pts.push(new THREE.Vector2(outerR(H) - WALL * 0.25, H + 0.022), new THREE.Vector2(outerR(H) - WALL * 0.75, H + 0.022));
  for (let i = N; i >= 0; i--) { const y = FLOOR + (i / N) * (H - FLOOR); pts.push(new THREE.Vector2(PROC.inner(y), y)); }
  pts.push(new THREE.Vector2(0.0001, FLOOR));
  const g = new THREE.LatheGeometry(pts, seg);
  g.computeVertexNormals();
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
  const glaze = new THREE.Color('#D8C9AC'), clay = new THREE.Color('#B58A60'), rim = HOT.clone(), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < 0.14) c.copy(clay); else if (y > H - 0.06) c.copy(rim); else c.copy(glaze);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// speckled satin glaze texture for the cup (and the fallback jar)
function speckleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#E2D6C0';
  x.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 900; i++) {
    x.fillStyle = Math.random() < 0.7 ? 'rgba(90,70,50,0.55)' : 'rgba(150,90,50,0.5)';
    const r = Math.random() * 0.9 + 0.3;
    x.beginPath(); x.arc(Math.random() * 256, Math.random() * 256, r, 0, 6.3); x.fill();
  }
  for (let y = 0; y < 256; y += 3) { x.fillStyle = `rgba(255,255,255,${0.03 + Math.random() * 0.03})`; x.fillRect(0, y, 256, 1); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 1);
  return t;
}

function cupGeometry(seg) {
  const h = 0.5, o = (y) => 0.22 + 0.13 * Math.sin((y / h) * Math.PI * 0.55);
  const pts = [new THREE.Vector2(0.0001, 0), new THREE.Vector2(0.17, 0), new THREE.Vector2(0.18, 0.04), new THREE.Vector2(0.205, 0.05)];
  for (let i = 1; i <= 16; i++) { const y = 0.05 + (i / 16) * (h - 0.05); pts.push(new THREE.Vector2(o(y), y)); }
  pts.push(new THREE.Vector2(o(h) - 0.012, h + 0.012), new THREE.Vector2(o(h) - 0.035, h + 0.012));
  for (let i = 16; i >= 0; i--) { const y = 0.08 + (i / 16) * (h - 0.08); pts.push(new THREE.Vector2(o(y) - 0.045, y)); }
  pts.push(new THREE.Vector2(0.0001, 0.08));
  const g = new THREE.LatheGeometry(pts, seg);
  g.computeVertexNormals();
  // raw clay foot ring
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    c.set(pos.getY(i) < 0.055 && Math.hypot(pos.getX(i), pos.getZ(i)) > 0.12 ? '#B58A60' : '#ffffff');
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return { g, h, inner: (y) => o(y) - 0.045 };
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const gr = x.createRadialGradient(64, 64, 2, 64, 64, 64);
  gr.addColorStop(0, 'rgba(84,54,26,0.5)');
  gr.addColorStop(0.35, 'rgba(84,54,26,0.22)');
  gr.addColorStop(1, 'rgba(84,54,26,0)');
  x.fillStyle = gr;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ───────────── shaders ─────────────
const liquidVert = /* glsl */ `
  uniform float uTime; uniform float uAmp; uniform vec2 uSlosh;
  varying vec3 vWorld; varying float vR;
  void main() {
    vec3 p = position;
    float r = length(p.xy);
    float a = atan(p.y, p.x);
    float w = sin(r * 9.0 - uTime * 2.4 + a * 2.0) * 0.5 + sin(r * 5.0 + uTime * 1.7 - a) * 0.5;
    float edge = 1.0 - smoothstep(0.82, 1.0, r);
    p.z += w * uAmp * edge + (uSlosh.x * p.x + uSlosh.y * p.y) * 0.12;
    vR = r;
    vec4 wp = modelMatrix * vec4(p, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;
const liquidFrag = /* glsl */ `
  uniform vec3 uDeep; uniform vec3 uCol; uniform vec3 uHot; uniform float uOver; uniform vec3 uLight;
  varying vec3 vWorld; varying float vR;
  void main() {
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (n.y < 0.0) n = -n;
    vec3 v = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - max(dot(n, v), 0.0), 3.0);
    vec3 h = normalize(normalize(uLight) + v);
    float spec = pow(max(dot(n, h), 0.0), 120.0);
    vec3 col = mix(uDeep, uCol, 0.3 + 0.7 * smoothstep(0.0, 1.0, vR));
    col *= 0.78 + 0.22 * smoothstep(1.0, 0.7, vR); // darker meniscus shadow at the wall
    col += fres * 0.22 + spec * 0.9;
    col = mix(col, uHot, smoothstep(0.86, 1.0, vR) * uOver * 0.85);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const streamVert = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const streamFrag = /* glsl */ `
  uniform float uTime; uniform float uReveal; uniform vec3 uHot;
  varying vec2 vUv;
  void main() {
    if (vUv.x > uReveal) discard;
    float band = 0.5 + 0.5 * sin(vUv.x * 60.0 - uTime * 14.0);
    float side = abs(vUv.y - 0.5) * 2.0;
    vec3 col = uHot * (0.86 + 0.14 * band) + vec3(0.28) * pow(1.0 - side, 6.0);
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;
const dropVert = /* glsl */ `
  attribute float aSeed; uniform float uTime; uniform float uSpill; uniform float uSize;
  uniform vec3 uP0; uniform vec3 uP1; uniform vec3 uP2; uniform vec3 uP3;
  varying float vA;
  vec3 bez(float t) { float u = 1.0 - t; return u*u*u*uP0 + 3.0*u*u*t*uP1 + 3.0*u*t*t*uP2 + t*t*t*uP3; }
  void main() {
    float t = fract(aSeed * 7.13 + uTime * (0.55 + fract(aSeed * 3.7) * 0.4));
    vec3 p = bez(t);
    float s = fract(aSeed * 13.7) - 0.5, q = fract(aSeed * 29.3) - 0.5;
    p += vec3(s, q * 0.4, q) * 0.1 * (0.3 + t);
    vA = step(aSeed, uSpill) * smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.9, 1.0, t));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (0.45 + fract(aSeed * 5.1) * 0.8) / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const dropFrag = /* glsl */ `
  uniform vec3 uHot; varying float vA;
  void main() {
    vec2 c = gl_PointCoord - 0.5; float d = length(c);
    if (d > 0.5 || vA < 0.01) discard;
    vec3 col = uHot + vec3(0.35) * smoothstep(0.25, 0.0, length(c - vec2(-0.15, -0.15)));
    gl_FragColor = vec4(col, vA * smoothstep(0.5, 0.38, d));
    #include <colorspace_fragment>
  }`;

export function createStage(canvas, opts = {}) {
  const mobile = opts.mobile ?? matchMedia('(max-width: 860px), (pointer: coarse)').matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.86;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xfff3e0, 0x7a5b3c, 0.45));

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  const CAM_DIST = 9;

  const root = new THREE.Group(); // placed on screen each frame
  const tilt = new THREE.Group(); // pointer tilt
  root.add(tilt);
  scene.add(root);
  const body = new THREE.Group();
  body.position.y = -H / 2;
  tilt.add(body);
  const spin = new THREE.Group(); // idle rotation of the jar only (the stream and cup keep their direction)
  body.add(spin);

  // studio lights travel with the jar so the shadow and highlights stay consistent wherever it is on screen
  const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
  key.position.set(1.4, 7.5, 2.2); // high key: a short, soft cast shadow
  key.target.position.set(0, 0.8, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(mobile ? 512 : 1024, mobile ? 512 : 1024);
  key.shadow.radius = 10;
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  Object.assign(key.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3, near: 0.5, far: 14 });
  body.add(key, key.target);
  const rim = new THREE.DirectionalLight(0xffe2c4, 1.1);
  rim.position.set(-3.5, 3, -4);
  body.add(rim);

  // shadow catcher + baked contact shadow
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.ShadowMaterial({ color: 0x5a3a1c, opacity: 0.1 }));
  catcher.rotation.x = -Math.PI / 2;
  catcher.position.y = 0.001;
  catcher.receiveShadow = true;
  body.add(catcher);
  const contactMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false });
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 2.3), contactMat);
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.003;
  body.add(contact);

  // jar: procedural first (instant), replaced by the GLB when it loads
  let P = PROC;
  const speckle = speckleTexture();
  const procMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true, map: speckle, roughness: 0.55, clearcoat: 0.6, clearcoatRoughness: 0.3, side: THREE.DoubleSide, envMapIntensity: 0.7,
  });
  const procJar = new THREE.Mesh(vesselGeometry(mobile ? 72 : 120), procMat);
  procJar.castShadow = true;
  spin.add(procJar);
  let ready = false;
  const onReady = [];
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.load(
    opts.model || '/models/vessel.glb',
    (gltf) => {
      const g = gltf.scene;
      g.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = false;
          const m = o.material;
          m.side = THREE.DoubleSide; // the inner wall's normals point outward in the scan
          m.envMapIntensity = 0.8;
          if ('clearcoat' in m === false) {
            o.material = new THREE.MeshPhysicalMaterial({ map: m.map, normalMap: m.normalMap, roughnessMap: m.roughnessMap, metalnessMap: m.metalnessMap, side: THREE.DoubleSide });
          }
          const pm = o.material;
          pm.metalness = 0; // a ceramic glaze is a dielectric
          pm.roughness = 0.62;
          pm.clearcoat = 0.45;
          pm.clearcoatRoughness = 0.28;
          pm.envMapIntensity = 0.8;
          // cut away the scan's inner wall (texture artefacts); the clean procedural sleeve shows instead
          // positions are quantized (meshopt): map mesh-local → jar model units (height −0.5..0.5) with a matrix
          const toJar = { value: new THREE.Matrix4() };
          o.userData.toJar = toJar;
          pm.onBeforeCompile = (sh) => {
            sh.uniforms.uToJar = toJar;
            sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform mat4 uToJar;\nvarying vec3 vBrimObj;')
              .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBrimObj = (uToJar * vec4(transformed, 1.0)).xyz;');
            sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vBrimObj;\n' + CUT_GLSL)
              .replace('void main() {', `void main() {
  {
    float yy = vBrimObj.y, rr = length(vBrimObj.xz);
    float ri = brimInner(yy), ro = brimOuter(yy);
    // the inner wall lives between the floor and the lip; keep a margin under the outer skin
    if (yy > -0.15 && yy < 0.478 && rr < max(ri + 0.03, ro - 0.025) && rr < ro - 0.012) discard;
  }`);
          };
          pm.customProgramCacheKey = () => 'brim-cut';
        }
      });
      g.scale.setScalar(2); // model is 1 unit tall, centred
      g.position.y = 1;
      spin.remove(procJar);
      spin.add(g);
      spin.add(innerSleeve()); // hides the scan's inner-wall texture artefacts
      g.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
      g.traverse((o) => { if (o.isMesh && o.userData.toJar) o.userData.toJar.value.multiplyMatrices(inv, o.matrixWorld); });
      P = TRIPO;
      buildRim();
      ready = true;
      onReady.forEach((f) => f());
    },
    undefined,
    (e) => { console.warn('vessel.glb failed, procedural jar kept', e); ready = true; onReady.forEach((f) => f()); }
  );

  // clean inner wall: satin cream, darker towards the floor (cheap ambient occlusion), rendered from the inside
  function innerSleeve() {
    const top = H - 0.008, n = 40, pts = [];
    for (let i = n; i >= 0; i--) { const y = TRIPO.floor + ((top - TRIPO.floor) * i) / n; pts.push(new THREE.Vector2(TRIPO.inner(y) - 0.006, y)); }
    const g = new THREE.LatheGeometry(pts, mobile ? 48 : 96);
    g.computeVertexNormals();
    const pos = g.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color(), lo = new THREE.Color('#8e8270'), hi = new THREE.Color('#ece3d2');
    for (let i = 0; i < pos.count; i++) {
      const t = THREE.MathUtils.smoothstep((pos.getY(i) - TRIPO.floor) / (top - TRIPO.floor), 0, 1);
      c.copy(lo).lerp(hi, 0.35 + 0.65 * t);
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: speckle, roughness: 0.6, metalness: 0, side: THREE.BackSide, envMapIntensity: 0.5 });
    const grp = new THREE.Group();
    grp.add(new THREE.Mesh(g, mat));
    const floor = new THREE.Mesh(new THREE.CircleGeometry(TRIPO.inner(TRIPO.floor) + 0.01, 40), new THREE.MeshStandardMaterial({ color: '#7f7462', map: speckle, roughness: 0.7 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = TRIPO.floor + 0.004;
    grp.add(floor);
    return grp;
  }

  // liquid surface
  const liqU = {
    uTime: { value: 0 }, uAmp: { value: 0.016 }, uSlosh: { value: new THREE.Vector2() },
    uDeep: { value: COBALT_DEEP }, uCol: { value: COBALT }, uHot: { value: HOT }, uOver: { value: 0 },
    uLight: { value: new THREE.Vector3(2.6, 5.5, 3.6) },
  };
  const liquid = new THREE.Mesh(
    new THREE.RingGeometry(0.0, 1, mobile ? 48 : 72, mobile ? 10 : 16),
    new THREE.ShaderMaterial({ uniforms: liqU, vertexShader: liquidVert, fragmentShader: liquidFrag, side: THREE.DoubleSide })
  );
  liquid.rotation.x = -Math.PI / 2;
  body.add(liquid);

  // brim line (the strike) + soft halo
  const brimMat = new THREE.MeshBasicMaterial({ color: HOT, transparent: true, opacity: 0.85, toneMapped: false });
  const haloMat = new THREE.MeshBasicMaterial({ color: HOT, transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
  let brim, halo;
  function buildRim() {
    if (brim) { body.remove(brim, halo); brim.geometry.dispose(); halo.geometry.dispose(); }
    brim = new THREE.Mesh(new THREE.TorusGeometry(P.lipR, 0.011, 8, 160), brimMat);
    halo = new THREE.Mesh(new THREE.TorusGeometry(P.lipR, 0.045, 8, 120), haloMat);
    for (const m of [brim, halo]) { m.rotation.x = Math.PI / 2; m.position.y = H + 0.012; body.add(m); }
    placeStream();
  }

  // buyer's cup
  const cupG = cupGeometry(mobile ? 48 : 72);
  const cup = new THREE.Group();
  const cupMesh = new THREE.Mesh(cupG.g, new THREE.MeshPhysicalMaterial({
    vertexColors: true, map: speckle, roughness: 0.55, clearcoat: 0.5, clearcoatRoughness: 0.3, side: THREE.DoubleSide, envMapIntensity: 0.7,
  }));
  cupMesh.castShadow = true;
  cup.add(cupMesh);
  const cupContact = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), contactMat);
  cupContact.rotation.x = -Math.PI / 2;
  cupContact.position.y = 0.003;
  cup.add(cupContact);
  const cupLiq = new THREE.Mesh(new THREE.CircleGeometry(1, 40), new THREE.MeshPhysicalMaterial({ color: HOT, roughness: 0.15, clearcoat: 1 }));
  cupLiq.rotation.x = -Math.PI / 2;
  cup.add(cupLiq);
  cup.position.set(1.62, 0, 0.75);
  body.add(cup);

  // stream from the lip (facing the cup) into the cup
  const strU = { uTime: liqU.uTime, uReveal: { value: 0 }, uHot: { value: HOT } };
  const streamMat = new THREE.ShaderMaterial({ uniforms: strU, vertexShader: streamVert, fragmentShader: streamFrag });
  let stream = null;
  const NDROP = mobile ? 140 : 340;
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NDROP * 3), 3));
  const seeds = new Float32Array(NDROP);
  for (let i = 0; i < NDROP; i++) seeds[i] = (i + 0.5) / NDROP;
  dg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const dropU = {
    uTime: liqU.uTime, uSpill: { value: 0 }, uSize: { value: 70 }, uHot: { value: HOT },
    uP0: { value: new THREE.Vector3() }, uP1: { value: new THREE.Vector3() }, uP2: { value: new THREE.Vector3() }, uP3: { value: new THREE.Vector3() },
  };
  const drops = new THREE.Points(dg, new THREE.ShaderMaterial({ uniforms: dropU, vertexShader: dropVert, fragmentShader: dropFrag, transparent: true, depthWrite: false }));
  drops.frustumCulled = false;
  body.add(drops);
  function placeStream() {
    const dir = new THREE.Vector3(cup.position.x, 0, cup.position.z).normalize();
    const P0 = dir.clone().multiplyScalar(P.lipR + 0.02).setY(H + 0.04);
    const P1 = dir.clone().multiplyScalar(P.lipR + 0.34).setY(H + 0.14);
    const P2 = cup.position.clone().add(new THREE.Vector3(-0.08, cupG.h + 0.9, -0.02));
    const P3 = cup.position.clone().setY(cupG.h * 0.55);
    if (stream) { body.remove(stream); stream.geometry.dispose(); }
    stream = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CubicBezierCurve3(P0, P1, P2, P3), 80, 0.032, 10, false), streamMat);
    body.add(stream);
    dropU.uP0.value.copy(P0); dropU.uP1.value.copy(P1); dropU.uP2.value.copy(P2); dropU.uP3.value.copy(P3);
  }
  buildRim();

  // decorative glazed ring for the statement block
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.62, 0.2, mobile ? 24 : 40, mobile ? 64 : 120),
    new THREE.MeshPhysicalMaterial({ color: COBALT, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.05 })
  );
  const ringBand = new THREE.Mesh(new THREE.TorusGeometry(0.83, 0.012, 8, 160), brimMat);
  const ringRoot = new THREE.Group();
  ringRoot.add(ring, ringBand);
  scene.add(ringRoot);

  // ---- public state (GSAP tweens these) ----
  const state = {
    x: 0.45, y: -0.1, size: 0.6, yaw: 0, elev: 0.42, // elev: camera elevation (rad): ~0.1 side view, ~0.9 looking into the mouth
    level: 0.55, spill: 0, cup: 0, cupFill: 0,
    ring: 0, rx: 0.6, ry: 0.4, rsize: 0.25,
    idle: 1, visible: 1, opacity: 1,
  };
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, vx: 0 };
  if (!mobile) addEventListener('pointermove', (e) => { pointer.tx = (e.clientX / innerWidth) * 2 - 1; pointer.ty = (e.clientY / innerHeight) * 2 - 1; }, { passive: true });

  let w = 0, h = 0;
  function resize() {
    w = innerWidth; h = innerHeight;
    const dpr = Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dropU.uSize.value = (mobile ? 44 : 66) * dpr * (h / 900);
  }
  resize();
  addEventListener('resize', resize);

  const tmp = new THREE.Vector3(), dirV = new THREE.Vector3(), fwd = new THREE.Vector3();
  function place(obj, nx, ny, sizeFrac, height) {
    tmp.set(nx, ny, 0.5).unproject(camera);
    dirV.copy(tmp).sub(camera.position).normalize();
    camera.getWorldDirection(fwd);
    obj.position.copy(camera.position).addScaledVector(dirV, CAM_DIST / dirV.dot(fwd));
    const visH = 2 * CAM_DIST * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    obj.scale.setScalar((sizeFrac * visH) / height);
  }

  const screen = { x: 0, y: 0, r: 0 };
  let running = true, inView = true, last = performance.now(), time = 0;
  const lerp = (a, b, k) => a + (b - a) * k;
  const listeners = [];
  const frameTimes = [];
  // pause when the canvas is not on screen at all (e.g. fully covered by later sections → state.visible = 0)
  new IntersectionObserver(([e]) => (inView = e.isIntersecting)).observe(canvas);

  function frame(now) {
    requestAnimationFrame(frame);
    if (!running || !inView || document.hidden || state.visible < 0.01) { last = now; return; }
    const dt = Math.min(0.05, (now - last) / 1000);
    if (frameTimes.length < 2000) frameTimes.push(now - last);
    last = now;
    time += dt;
    liqU.uTime.value = time;

    // camera orbit (elevation) + small pointer parallax
    pointer.vx = pointer.tx - pointer.x;
    pointer.x = lerp(pointer.x, pointer.tx, 0.05);
    pointer.y = lerp(pointer.y, pointer.ty, 0.05);
    const el = state.elev + pointer.y * 0.04;
    camera.position.set(pointer.x * 0.35, Math.sin(el) * CAM_DIST, Math.cos(el) * CAM_DIST);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    place(root, state.x, state.y, state.size * 1.25, H + 0.6);
    root.rotation.set(0, state.yaw, 0);
    tilt.rotation.z = -pointer.x * 0.06;
    tilt.rotation.x = pointer.y * 0.045;
    spin.rotation.y += dt * 0.12 * state.idle; // slow idle turn of the jar
    liqU.uSlosh.value.x = lerp(liqU.uSlosh.value.x, -pointer.vx * 2.0, 0.08);

    // shadow frustum follows the jar's on-screen scale
    const sc = root.scale.x;
    Object.assign(key.shadow.camera, { left: -3 * sc, right: 3 * sc, top: 3 * sc, bottom: -3 * sc, near: 0.5 * sc, far: 14 * sc });
    key.shadow.camera.updateProjectionMatrix();

    // liquid
    const lv = state.level;
    const top = H - 0.07;
    const ly = lv <= 1 ? P.floor + (top - P.floor) * lv : top + (lv - 1) * 0.5;
    liquid.position.y = ly;
    const rr = lv >= 0.985 ? P.lipInner - 0.005 : P.inner(ly) - (P === TRIPO ? 0.014 : 0.012);
    liquid.scale.set(rr, rr, 1);
    liquid.visible = lv > 0.01;
    liqU.uAmp.value = 0.012 + 0.018 * Math.min(1, state.spill + Math.abs(pointer.vx) * 6);
    const near = THREE.MathUtils.smoothstep(lv, 0.82, 1.0);
    liqU.uOver.value = THREE.MathUtils.smoothstep(lv, 0.98, 1.06);
    brimMat.opacity = 0.5 + 0.5 * near;
    haloMat.opacity = 0.04 + 0.22 * near + 0.05 * Math.sin(time * 3) * near;

    // spill + cup
    strU.uReveal.value = state.spill;
    if (stream) stream.visible = state.spill > 0.001;
    dropU.uSpill.value = state.spill;
    drops.visible = state.spill > 0.001;
    cup.visible = state.cup > 0.01;
    cup.scale.setScalar(Math.max(0.001, state.cup));
    const cy = 0.1 + (cupG.h - 0.14) * state.cupFill;
    cupLiq.position.y = cy;
    cupLiq.scale.setScalar(cupG.inner(cy) - 0.004);
    cupLiq.visible = state.cupFill > 0.01;

    ringRoot.visible = state.ring > 0.01;
    if (ringRoot.visible) {
      place(ringRoot, state.rx, state.ry, state.rsize * state.ring, 1.7);
      ringRoot.quaternion.copy(camera.quaternion);
      ring.rotation.set(1.1 + Math.sin(time * 0.5) * 0.25 + pointer.y * 0.2, time * 0.35 + pointer.x * 0.3, 0.4);
      ringBand.rotation.copy(ring.rotation);
    }

    canvas.style.opacity = state.opacity;
    tmp.set(0, 0, 0).applyMatrix4(tilt.matrixWorld).project(camera);
    screen.x = (tmp.x * 0.5 + 0.5) * w;
    screen.y = (-tmp.y * 0.5 + 0.5) * h;
    screen.r = state.size * h * 0.42;

    renderer.render(scene, camera);
    for (const f of listeners) f(screen, state);
  }
  requestAnimationFrame(frame);

  return {
    state, screen, renderer, frameTimes,
    onFrame: (f) => listeners.push(f),
    whenReady: (f) => (ready ? f() : onReady.push(f)),
    pause: () => (running = false),
    resume: () => (running = true),
  };
}
