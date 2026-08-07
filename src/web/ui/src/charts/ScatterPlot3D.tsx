import { useEffect, useRef } from "preact/hooks";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export interface ScatterPlot3DPoint {
  id: string;
  x: number;
  y: number;
  z: number;
  color: string;
  label: string;
}

interface ScatterPlot3DProps {
  points: ScatterPlot3DPoint[];
  width?: number;
  height?: number;
  onPointClick?: (id: string) => void;
  pointSize?: number;
  resetKey?: number;
  selectedId?: string | null;
}

const DEFAULT_CAMERA_Z = 3;

interface SceneState {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  renderer: THREE.WebGLRenderer;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  raycaster: THREE.Raycaster;
  crosshair: THREE.LineSegments;
  axes: THREE.AxesHelper;
  ids: string[];
  raf: number;
  ro: ResizeObserver;
}

export function ScatterPlot3D({
  points,
  width = 900,
  height = 600,
  onPointClick,
  pointSize = 5,
  resetKey = 0,
  selectedId = null,
}: ScatterPlot3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<SceneState | null>(null);
  const onPointClickRef = useRef(onPointClick);
  onPointClickRef.current = onPointClick;
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const pointSizeRef = useRef(pointSize);
  pointSizeRef.current = pointSize;

  // Initialise the three.js scene once; props are read through refs so the
  // empty dependency array cannot go stale. Everything is torn down on unmount.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.001, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    const geometry = new THREE.BufferGeometry();
    const material = new THREE.PointsMaterial({
      size: worldSize(pointSizeRef.current),
      vertexColors: true,
      sizeAttenuation: true,
      map: getCircleTexture(),
      transparent: true,
    });
    const pointCloud = new THREE.Points(geometry, material);
    scene.add(pointCloud);

    // Unit-length helper; position/scale are set per data bounds in
    // rebuildGeometry (origin at the data bbox min corner, like ClickSphere).
    const axes = new THREE.AxesHelper(1);
    scene.add(axes);

    const crosshair = makeCrosshair();
    crosshair.visible = false;
    scene.add(crosshair);

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = material.size * 0.7;
    const pointer = new THREE.Vector2();

    const pick = (clientX: number, clientY: number): number | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(pointCloud);
      return hits.length > 0 ? hits[0]!.index ?? null : null;
    };

    // Drag-vs-click: only treat a press as a click when the pointer barely
    // moved and was released quickly (orbit drags must not navigate).
    let downPos: { x: number; y: number } | null = null;
    let downTime = 0;
    const onPointerDown = (e: PointerEvent) => {
      downPos = { x: e.clientX, y: e.clientY };
      downTime = Date.now();
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!downPos) return;
      const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
      const dur = Date.now() - downTime;
      downPos = null;
      if (moved < 5 && dur < 400) {
        const idx = pick(e.clientX, e.clientY);
        if (idx !== null) {
          const id = stateRef.current?.ids[idx];
          if (id !== undefined) onPointClickRef.current?.(id);
        }
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    const ro = new ResizeObserver(() => {
      const W = container.clientWidth || width;
      const H = container.clientHeight || height;
      renderer.setSize(W, H);
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
    });
    ro.observe(container);

    camera.position.set(0, 0, DEFAULT_CAMERA_Z);
    controls.target.set(0, 0, 0);
    controls.update();

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    stateRef.current = {
      camera,
      controls,
      renderer,
      geometry,
      material,
      raycaster,
      crosshair,
      axes,
      ids: [],
      raf,
      ro,
    };
    rebuildGeometry(stateRef.current, pointsRef.current);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      geometry.dispose();
      material.dispose();
      crosshair.geometry.dispose();
      (crosshair.material as THREE.Material).dispose();
      axes.geometry.dispose();
      (axes.material as THREE.Material).dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
      stateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Rebuild the point cloud when the data changes.
  useEffect(() => {
    const st = stateRef.current;
    if (st) rebuildGeometry(st, points);
  }, [points]);

  // Point size changes.
  useEffect(() => {
    const st = stateRef.current;
    if (st) {
      st.material.size = worldSize(pointSize);
      st.raycaster.params.Points.threshold = st.material.size * 0.7;
    }
  }, [pointSize]);

  // Reset camera when the parent increments resetKey.
  useEffect(() => {
    const st = stateRef.current;
    if (st && resetKey > 0) {
      st.camera.position.set(0, 0, DEFAULT_CAMERA_Z);
      st.controls.target.set(0, 0, 0);
      st.controls.update();
    }
  }, [resetKey]);

  // Move the crosshair onto the selected point.
  useEffect(() => {
    const st = stateRef.current;
    if (!st) return;
    if (selectedId == null) {
      st.crosshair.visible = false;
      return;
    }
    const idx = st.ids.indexOf(selectedId);
    if (idx === -1) {
      st.crosshair.visible = false;
      return;
    }
    const pos = st.geometry.attributes.position;
    st.crosshair.position.set(
      pos.array[idx * 3]!,
      pos.array[idx * 3 + 1]!,
      pos.array[idx * 3 + 2]!
    );
    st.crosshair.visible = true;
  }, [selectedId, points]);

  return (
    <div
      ref={containerRef}
      className="relative overflow-hidden rounded-lg border border-slate-700 bg-slate-900"
      style={{ width, height }}
    />
  );
}

function worldSize(pointSize: number): number {
  return 0.006 * pointSize;
}

/** Rebuild positions/colors from the current data, centered at the origin and scaled to a unit cube. */
function rebuildGeometry(state: SceneState, points: ScatterPlot3DPoint[]): void {
  const n = points.length;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const ids = new Array<string>(n);

  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    positions[i * 3] = p.x;
    positions[i * 3 + 1] = p.y;
    positions[i * 3 + 2] = p.z;
    const [r, g, b] = colorToRgb(p.color);
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
    ids[i] = p.id;
  }

  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let i = 0; i < n; i++) {
    sx += positions[i * 3]!;
    sy += positions[i * 3 + 1]!;
    sz += positions[i * 3 + 2]!;
  }
  const cx = sx / n;
  const cy = sy / n;
  const cz = sz / n;

  let maxExtent = 0;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]! - cx;
    const y = positions[i * 3 + 1]! - cy;
    const z = positions[i * 3 + 2]! - cz;
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    maxExtent = Math.max(maxExtent, Math.abs(x), Math.abs(y), Math.abs(z));
  }
  if (maxExtent > 0) {
    const inv = 1 / maxExtent;
    for (let i = 0; i < positions.length; i++) positions[i]! *= inv;
  }

  state.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  state.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  state.ids = ids;

  // setAttribute does NOT invalidate the cached bounding sphere. A sphere
  // computed while the geometry was still empty (radius -1 sentinel) makes
  // every raycaster pass fail its sphere pre-check — reset it so the engine
  // recomputes from the current positions on demand.
  state.geometry.boundingSphere = null;

  // Axes anchored at the data bbox min corner, extending 1.15x the max extent.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  state.axes.position.set(minX, minY, minZ);
  state.axes.scale.setScalar((extent > 0 ? extent : 1) * 1.15);
}

/** Parse a CSS color into [r, g, b] floats in [0, 1]; supports #hex and hsl(). */
function colorToRgb(color: string): [number, number, number] {
  if (color.startsWith("hsl")) {
    const m = color.match(/hsl\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)%,\s*(\d+(?:\.\d+)?)%\)/);
    if (m) return hslToRgb(parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!));
  }
  const h = color.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hp = ((h % 360) + 360) % 360 / 60;
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = ln - c / 2;
  return [r + m, g + m, b + m];
}

function makeCrosshair(): THREE.LineSegments {
  const cs = 0.06;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(
      new Float32Array([
        -cs, 0, 0, cs, 0, 0,
        0, -cs, 0, 0, cs, 0,
        0, 0, -cs, 0, 0, cs,
      ]),
      3
    )
  );
  geometry.setAttribute(
    "color",
    new THREE.BufferAttribute(
      new Float32Array([
        1, 0, 0, 1, 0, 0,
        0, 1, 0, 0, 1, 0,
        0, 0, 1, 0, 0, 1,
      ]),
      3
    )
  );
  const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false });
  return new THREE.LineSegments(geometry, material);
}

let circleTexture: THREE.CanvasTexture | null = null;

function getCircleTexture(): THREE.CanvasTexture {
  if (circleTexture) return circleTexture;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = "white";
  ctx.fill();
  circleTexture = new THREE.CanvasTexture(canvas);
  return circleTexture;
}
