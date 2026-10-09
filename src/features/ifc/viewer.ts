import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as WebIFC from "web-ifc";

/**
 * Enkel IFC-viewer: web-ifc (WASM) parser modellen i nettleseren, three.js tegner den.
 * Én mesh per IFC-element (sammenslått geometri) – godt nok for modeller opp til noen titalls tusen elementer.
 */

export interface StoreyInfo {
  expressID: number;
  guid: string;
  name: string;
  elevation: number | null;
  elementCount: number;
  spaces: { expressID: number; guid: string; name: string; long_name: string | null; area: number | null }[];
}

export interface ElementInfo {
  express_id: number;
  guid: string | null;
  ifc_type: string;
  name: string | null;
  storey: string | null;
  props?: Record<string, unknown>;
}

export interface SelectedElement {
  expressID: number;
  type: string;
  name: string | null;
  guid: string | null;
  storey: string | null;
  storeyGuid: string | null;
  attributes: [string, string][];
  psets: { name: string; values: [string, string][] }[];
}

const SKIP_GEOMETRY = new Set([WebIFC.IFCSPACE, WebIFC.IFCOPENINGELEMENT]);

function val(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object" && v !== null && "value" in v) return val((v as { value: unknown }).value);
  if (typeof v === "string") {
    try {
      // IFC-strenger kan være kodet (\X2\…\X0\)
      return decodeIfcString(v);
    } catch {
      return v;
    }
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function decodeIfcString(s: string): string {
  return s
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_m, hex: string) => {
      let out = "";
      for (let i = 0; i < hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    })
    .replace(/\\X\\([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_m, ch: string) => String.fromCharCode(ch.charCodeAt(0) + 128));
}

export class IfcViewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private ifc = new WebIFC.IfcAPI();
  private modelID = -1;
  meshes = new Map<number, THREE.Mesh>();
  private storeyOfElement = new Map<number, number>();
  private storeyNames = new Map<number, { name: string; guid: string }>();
  private materials = new Map<string, THREE.MeshLambertMaterial>();
  private highlightMat = new THREE.MeshLambertMaterial({ color: 0xd08a4f, emissive: 0x6a3410, depthTest: true });
  private selected: number | null = null;
  private raycaster = new THREE.Raycaster();
  private resizeObserver: ResizeObserver;
  private disposed = false;
  schema = "IFC";

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, container.clientWidth / Math.max(container.clientHeight, 1), 0.1, 5000);
    this.camera.position.set(30, 25, 30);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener("change", () => this.render());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8070, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(50, 80, 40);
    this.scene.add(sun);

    this.resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.render();
    });
    this.resizeObserver.observe(container);
  }

  render() {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  private material(c: { x: number; y: number; z: number; w: number }) {
    const key = `${c.x.toFixed(3)}-${c.y.toFixed(3)}-${c.z.toFixed(3)}-${c.w.toFixed(2)}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: new THREE.Color(c.x, c.y, c.z), transparent: c.w < 1, opacity: c.w, side: THREE.DoubleSide, depthWrite: c.w >= 1 });
      this.materials.set(key, m);
    }
    return m;
  }

  async load(data: Uint8Array, onProgress: (msg: string) => void) {
    onProgress("Starter IFC-motoren …");
    this.ifc.SetWasmPath("/wasm/", true);
    await this.ifc.Init(undefined, true);
    this.ifc.SetLogLevel(WebIFC.LogLevel.LOG_LEVEL_OFF);
    onProgress("Leser modellen …");
    this.modelID = this.ifc.OpenModel(data, { COORDINATE_TO_ORIGIN: true });
    this.schema = this.ifc.GetModelSchema(this.modelID);

    onProgress("Bygger geometri …");
    let count = 0;
    const tmp = new THREE.Matrix4();
    this.ifc.StreamAllMeshes(this.modelID, (flat) => {
      const type = this.ifc.GetLineType(this.modelID, flat.expressID);
      if (SKIP_GEOMETRY.has(type)) return;
      const parts: THREE.BufferGeometry[] = [];
      let color: { x: number; y: number; z: number; w: number } | null = null;
      const placed = flat.geometries as unknown as { size(): number; get(i: number): WebIFC.PlacedGeometry };
      for (let i = 0; i < placed.size(); i++) {
        const pg = placed.get(i);
        const geom = this.ifc.GetGeometry(this.modelID, pg.geometryExpressID) as unknown as {
          GetVertexData(): number;
          GetVertexDataSize(): number;
          GetIndexData(): number;
          GetIndexDataSize(): number;
          delete(): void;
        };
        const verts = this.ifc.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const index = this.ifc.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        const n = verts.length / 6;
        const pos = new Float32Array(n * 3);
        const nor = new Float32Array(n * 3);
        for (let v = 0; v < n; v++) {
          pos[v * 3] = verts[v * 6]!;
          pos[v * 3 + 1] = verts[v * 6 + 1]!;
          pos[v * 3 + 2] = verts[v * 6 + 2]!;
          nor[v * 3] = verts[v * 6 + 3]!;
          nor[v * 3 + 1] = verts[v * 6 + 4]!;
          nor[v * 3 + 2] = verts[v * 6 + 5]!;
        }
        const bg = new THREE.BufferGeometry();
        bg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        bg.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
        bg.setIndex(new THREE.BufferAttribute(new Uint32Array(index), 1));
        bg.applyMatrix4(tmp.fromArray(pg.flatTransformation));
        parts.push(bg);
        color ??= pg.color;
        geom.delete();
      }
      if (parts.length === 0) return;
      const merged = parts.length === 1 ? parts[0]! : mergeGeometries(parts);
      const mesh = new THREE.Mesh(merged, this.material(color ?? { x: 0.8, y: 0.8, z: 0.8, w: 1 }));
      mesh.userData.expressID = flat.expressID;
      this.meshes.set(flat.expressID, mesh);
      this.scene.add(mesh);
      if (++count % 500 === 0) onProgress(`Bygger geometri … ${count} elementer`);
    });

    onProgress("Leser romstruktur …");
    await this.buildSpatialIndex();
    this.fit();
    onProgress("");
  }

  private async buildSpatialIndex() {
    type Node = { expressID: number; type: string; children: Node[] };
    const root = (await this.ifc.properties.getSpatialStructure(this.modelID, false)) as Node;
    const walk = (node: Node, storey: number | null) => {
      let current = storey;
      // web-ifc returnerer typenavn med blandet store/små bokstaver (f.eks. «IfcBuildingStorey»)
      const isStorey = node.type.toUpperCase() === "IFCBUILDINGSTOREY";
      if (isStorey) {
        current = node.expressID;
        const line = this.ifc.GetLine(this.modelID, node.expressID);
        this.storeyNames.set(node.expressID, { name: val(line?.Name) ?? val(line?.LongName) ?? "Etasje", guid: val(line?.GlobalId) ?? "" });
      }
      if (current != null && !isStorey) this.storeyOfElement.set(node.expressID, current);
      for (const c of node.children ?? []) walk(c, current);
    };
    walk(root, null);
  }

  /** Etasjer med rom (for import til Plank) */
  async getStoreys(): Promise<StoreyInfo[]> {
    const out: StoreyInfo[] = [];
    for (const [id, info] of this.storeyNames) {
      const line = this.ifc.GetLine(this.modelID, id);
      const elevation = Number(val(line?.Elevation));
      const elements = [...this.storeyOfElement.entries()].filter(([, s]) => s === id).map(([e]) => e);
      const spaces: StoreyInfo["spaces"] = [];
      for (const e of elements) {
        if (this.ifc.GetLineType(this.modelID, e) !== WebIFC.IFCSPACE) continue;
        const sp = this.ifc.GetLine(this.modelID, e);
        spaces.push({ expressID: e, guid: val(sp?.GlobalId) ?? String(e), name: val(sp?.Name) ?? "Rom", long_name: val(sp?.LongName), area: await this.spaceArea(e) });
      }
      out.push({ expressID: id, guid: info.guid, name: info.name, elevation: Number.isFinite(elevation) ? elevation : null, elementCount: elements.length, spaces });
    }
    return out.sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
  }

  private async spaceArea(id: number): Promise<number | null> {
    try {
      const sets = (await this.ifc.properties.getPropertySets(this.modelID, id, true)) as any[];
      let gross: number | null = null;
      for (const s of sets) {
        for (const q of [...(s?.Quantities ?? []), ...(s?.HasProperties ?? [])]) {
          const name = val(q?.Name) ?? "";
          const v = Number(val(q?.AreaValue) ?? val(q?.NominalValue));
          if (!Number.isFinite(v) || v <= 0) continue;
          if (/^NetFloorArea$/i.test(name)) return Math.round(v * 10) / 10;
          if (/GrossFloorArea|^Area$|Areal/i.test(name)) gross ??= Math.round(v * 10) / 10;
        }
      }
      return gross;
    } catch {
      return null;
    }
  }

  /** Elementindeks (for agentenes spørringer) */
  getElements(): ElementInfo[] {
    const out: ElementInfo[] = [];
    for (const [id, storeyId] of this.storeyOfElement) {
      const type = this.ifc.GetNameFromTypeCode(this.ifc.GetLineType(this.modelID, id));
      if (!type || type.toUpperCase() === "IFCBUILDINGSTOREY") continue;
      const line = this.ifc.GetLine(this.modelID, id);
      const props: Record<string, unknown> = {};
      const objectType = val(line?.ObjectType);
      const tag = val(line?.Tag);
      const longName = val(line?.LongName);
      const predefined = val(line?.PredefinedType);
      if (objectType) props.ObjectType = objectType;
      if (tag) props.Tag = tag;
      if (longName) props.LongName = longName;
      if (predefined && predefined !== "NOTDEFINED") props.PredefinedType = predefined;
      out.push({ express_id: id, guid: val(line?.GlobalId), ifc_type: type, name: val(line?.Name), storey: this.storeyNames.get(storeyId)?.name ?? null, props: Object.keys(props).length ? props : undefined });
    }
    return out;
  }

  /** Etasjer sortert ovenfra og ned */
  getStoreyList() {
    return [...this.storeyNames.entries()]
      .map(([id, s]) => ({ id, name: s.name, guid: s.guid, elevation: Number(val(this.ifc.GetLine(this.modelID, id)?.Elevation)) || 0 }))
      .sort((a, b) => b.elevation - a.elevation);
  }

  setStoreyVisible(storeyId: number, visible: boolean) {
    for (const [el, s] of this.storeyOfElement) {
      if (s !== storeyId) continue;
      const m = this.meshes.get(el);
      if (m) m.visible = visible;
    }
    this.render();
  }

  isolateStorey(storeyId: number | null) {
    for (const [el, mesh] of this.meshes) mesh.visible = storeyId == null || this.storeyOfElement.get(el) === storeyId;
    this.render();
  }

  fit() {
    const box = new THREE.Box3();
    for (const m of this.meshes.values()) if (m.visible) box.expandByObject(m);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = (sphere.radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.05;
    const dir = new THREE.Vector3(1, 0.7, 1.2).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 200, 0.01);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.render();
  }

  pick(clientX: number, clientY: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(mouse, this.camera);
    const hits = this.raycaster.intersectObjects([...this.meshes.values()].filter((m) => m.visible), false);
    return hits.length ? (hits[0]!.object.userData.expressID as number) : null;
  }

  select(expressID: number | null) {
    if (this.selected != null) {
      const prev = this.meshes.get(this.selected);
      if (prev?.userData.originalMaterial) prev.material = prev.userData.originalMaterial;
    }
    this.selected = expressID;
    if (expressID != null) {
      const m = this.meshes.get(expressID);
      if (m) {
        m.userData.originalMaterial = m.material;
        m.material = this.highlightMat;
      }
    }
    this.render();
  }

  async describe(expressID: number): Promise<SelectedElement> {
    const line = this.ifc.GetLine(this.modelID, expressID, false);
    const type = this.ifc.GetNameFromTypeCode(this.ifc.GetLineType(this.modelID, expressID));
    const attributes: [string, string][] = [];
    for (const key of ["ObjectType", "Tag", "Description", "LongName", "PredefinedType"]) {
      const v = val(line?.[key]);
      if (v) attributes.push([key, v]);
    }
    const psets: SelectedElement["psets"] = [];
    try {
      const sets = (await this.ifc.properties.getPropertySets(this.modelID, expressID, true, true)) as any[];
      for (const s of sets) {
        const values: [string, string][] = [];
        for (const p of [...(s?.HasProperties ?? []), ...(s?.Quantities ?? [])]) {
          const name = val(p?.Name);
          const v = val(p?.NominalValue) ?? val(p?.AreaValue) ?? val(p?.LengthValue) ?? val(p?.VolumeValue) ?? val(p?.CountValue) ?? val(p?.WeightValue);
          if (name && v != null) values.push([name, v]);
        }
        if (values.length) psets.push({ name: val(s?.Name) ?? "Egenskaper", values });
      }
    } catch {
      /* ignorer */
    }
    const storeyId = this.storeyOfElement.get(expressID);
    const storey = storeyId != null ? this.storeyNames.get(storeyId) : undefined;
    return { expressID, type, name: val(line?.Name), guid: val(line?.GlobalId), storey: storey?.name ?? null, storeyGuid: storey?.guid ?? null, attributes, psets };
  }

  typeCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const id of this.meshes.keys()) {
      const t = this.ifc.GetNameFromTypeCode(this.ifc.GetLineType(this.modelID, id));
      counts[t] = (counts[t] ?? 0) + 1;
    }
    return counts;
  }

  dispose() {
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const m of this.meshes.values()) m.geometry.dispose();
    for (const m of this.materials.values()) m.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    try {
      if (this.modelID >= 0) this.ifc.CloseModel(this.modelID);
      this.ifc.Dispose();
    } catch {
      /* ignorer */
    }
  }
}

/** Slår sammen geometrier med samme attributter (posisjon, normal, indeks) */
function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of parts) {
    vertexCount += p.attributes.position!.count;
    indexCount += p.index!.count;
  }
  const pos = new Float32Array(vertexCount * 3);
  const nor = new Float32Array(vertexCount * 3);
  const idx = new Uint32Array(indexCount);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    pos.set(p.attributes.position!.array as Float32Array, vo * 3);
    nor.set(p.attributes.normal!.array as Float32Array, vo * 3);
    const src = p.index!.array as Uint32Array;
    for (let i = 0; i < src.length; i++) idx[io + i] = src[i]! + vo;
    vo += p.attributes.position!.count;
    io += src.length;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}
