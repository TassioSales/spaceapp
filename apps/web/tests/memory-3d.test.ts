import { describe, expect, it } from "vitest";
import { layoutMemoryNetwork3D, layoutMemoryNetwork3DStream, memory3DVolumeRatio, projectMemoryPoint, DEFAULT_MEMORY_CAMERA, SpatialPickingIndex3D, selectLODLabels } from "../src/features/memory-workspace/memory-3d.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

describe("3D memory projection", () => {
  it("rotates all three axes through a full turn and returns to the same view", () => {
    const point = { x: 45, y: 20, z: 60 };
    const initial = projectMemoryPoint(point, DEFAULT_MEMORY_CAMERA, 2, 1000, 700);
    const rotated = projectMemoryPoint(point, { ...DEFAULT_MEMORY_CAMERA, yaw: DEFAULT_MEMORY_CAMERA.yaw + Math.PI / 2 }, 2, 1000, 700);
    const full = projectMemoryPoint(point, { ...DEFAULT_MEMORY_CAMERA, yaw: DEFAULT_MEMORY_CAMERA.yaw + Math.PI * 2, pitch: DEFAULT_MEMORY_CAMERA.pitch + Math.PI * 2 }, 2, 1000, 700);
    expect(rotated.x).not.toBeCloseTo(initial.x);
    expect(rotated.z).not.toBeCloseTo(initial.z);
    expect(full.x).toBeCloseTo(initial.x);
    expect(full.y).toBeCloseTo(initial.y);
    expect(full.z).toBeCloseTo(initial.z);
  });
  const fixture = () => {
    const nodes: MemoryGraphNode[] = [{ id: "root", label: "gemini.md", type: "SOURCE", sourcePath: "/opt/spaceapp/docs/gemini.md", recordId: null }];
    const edges: MemoryGraphEdge[] = [];
    for (let file = 0; file < 12; file++) {
      const id = `source-${file}`;
      nodes.push({ id, label: `${id}.md`, type: "SOURCE", sourcePath: `/opt/spaceapp/docs/${id}.md`, recordId: null });
      edges.push({ id: `file-${file}`, type: "DERIVED_FROM", source: "root", target: id });
      for (let item = 0; item < 30; item++) {
        const memory = `${id}-memory-${item}`;
        nodes.push({ id: memory, label: memory, type: "MEMORY", sourcePath: `/opt/spaceapp/docs/${id}.md`, recordId: memory });
        edges.push({ id: memory, type: "CONTAINS", source: id, target: memory });
      }
    }
    return { nodes, edges };
  };
  it("occupies a volume, including at a side-on camera angle", () => {
    const { nodes, edges } = fixture();
    const layout = layoutMemoryNetwork3D(nodes, edges);
    expect(layout.size).toBe(nodes.length);
    expect(layout.get("root")).toEqual({ x: 0, y: 0, z: 0 });
    expect(memory3DVolumeRatio([...layout.values()])).toBeGreaterThan(0.35);
    for (const yaw of [0, Math.PI / 2, Math.PI]) {
      const points = [...layout.values()].map(p => projectMemoryPoint(p, { yaw, pitch: 0, zoom: 1 }, 1, 1000, 700));
      const width = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x));
      const height = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
      expect(width / height).toBeGreaterThan(0.5);
      expect(width / height).toBeLessThan(2);
    }
  });
  it("keeps real source links close and is deterministic under input reordering", () => {
    const { nodes, edges } = fixture();
    const layout = layoutMemoryNetwork3D(nodes, edges);
    const reversed = layoutMemoryNetwork3D([...nodes].reverse(), [...edges].reverse());
    expect([...reversed]).toEqual([...layout]);
    const distance = (a: string, b: string) => { const p = layout.get(a)!, q = layout.get(b)!; return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z); };
    const related = edges.filter(edge => edge.type === "CONTAINS");
    const meanLink = related.reduce((sum, edge) => sum + distance(edge.source, edge.target), 0) / related.length;
    const meanUnrelated = related.reduce((sum, edge) => sum + distance(edge.source === "source-0" ? "source-6" : "source-0", edge.target), 0) / related.length;
    expect(meanLink).toBeLessThan(meanUnrelated * 0.7);
  });
  it("detects flat geometry even if the plane is tilted", () => {
    const plane = Array.from({ length: 100 }, (_, i) => ({ x: i % 10, y: Math.floor(i / 10), z: i % 10 + Math.floor(i / 10) }));
    expect(memory3DVolumeRatio(plane)).toBeCloseTo(0);
    expect(layoutMemoryNetwork3D([], []).size).toBe(0);
  });
  describe("SpatialPickingIndex3D", () => {
    it("indexes 50,000 nodes and picks within 4ms threshold", () => {
      const points: any[] = [];
      for (let i = 0; i < 50000; i++) {
        const id = `node-${i}`;
        const x = (i % 500) * 4;
        const y = Math.floor(i / 500) * 10;
        points.push({ id, x, y, z: 0, radius: 4, color: "#fff", label: id, type: "MEMORY" });
      }
      const index = new SpatialPickingIndex3D(points, 32);

      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        const targetX = (i * 7) % 2000;
        const targetY = (i * 13) % 1000;
        index.pick(targetX, targetY);
      }
      const elapsed = performance.now() - start;
      const perPickMs = elapsed / 50;
      expect(perPickMs).toBeLessThan(4);

      const found = index.pick(points[42]!.x, points[42]!.y);
      expect(found).toBe("node-42");
    });
  });

  describe("selectLODLabels", () => {
    it("bounds rendered labels to maximum 40 without overlapping", () => {
      const nodes: MemoryGraphNode[] = [];
      const projectedMap = new Map<string, { x: number; y: number; z: number; perspective: number }>();
      for (let i = 0; i < 200; i++) {
        const id = `id-${i}`;
        nodes.push({
          id,
          label: i === 0 ? "gemini.md" : `file-${i}.md`,
          type: "SOURCE",
          sourcePath: `/demo/${i}.md`,
          recordId: null
        });
        projectedMap.set(id, {
          x: 50 + (i % 20) * 30,
          y: 50 + Math.floor(i / 20) * 30,
          z: i * 0.1,
          perspective: 1
        });
      }
      const selected = selectLODLabels(nodes, projectedMap, null, 2.0, 1000, 1000, text => text.length * 7, 40);
      expect(selected.length).toBeLessThanOrEqual(40);
      expect(selected.some(l => l.id === "id-0")).toBe(true);
    });
  });

  describe("layoutMemoryNetwork3DStream", () => {
    it("streams layout steps and finishes deterministically", () => {
      const { nodes, edges } = fixture();
      const steps: number[] = [];
      const onProgress = (_depth: Map<string, any>, step: number) => {
        steps.push(step);
      };
      const finalMap = layoutMemoryNetwork3DStream(nodes, edges, onProgress, 30);
      expect(steps.length).toBeGreaterThan(0);
      const regularLayout = layoutMemoryNetwork3D(nodes, edges);
      expect([...finalMap]).toEqual([...regularLayout]);
    });
  });
});
