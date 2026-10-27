import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";
import type { MemoryAtlasPosition } from "./memory-atlas.js";
import { isMemoryCoreLabel } from "./memory-graph-visuals.js";
import {
  DEFAULT_MEMORY_CAMERA,
  memory3DVolumeRatio,
  projectMemoryPoint,
  SpatialPickingIndex3D,
  selectLODLabels,
  type MemoryCamera3D,
  type MemoryPoint3D,
  type ProjectedMemoryPoint
} from "./memory-3d.js";

const POINT_VS = `#version 300 es
precision highp float;

in vec3 a_position;
in vec4 a_color;
in float a_radius;
in float a_flags;

uniform vec2 u_resolution;
uniform vec3 u_camera; // yaw, pitch, zoom
uniform float u_scale;

out vec4 v_color;
out float v_flags;

void main() {
  float yaw = u_camera.x;
  float pitch = u_camera.y;
  float zoom = u_camera.z;

  float x_rot = a_position.x * cos(yaw) + a_position.z * sin(yaw);
  float depth = -a_position.x * sin(yaw) + a_position.z * cos(yaw);
  float y_rot = a_position.y * cos(pitch) - depth * sin(pitch);
  float z_rot = a_position.y * sin(pitch) + depth * cos(pitch);

  float perspective = 650.0 / max(120.0, 650.0 + z_rot * u_scale);

  float screen_x = (x_rot * u_scale * zoom * perspective) / (u_resolution.x * 0.5);
  float screen_y = (y_rot * u_scale * zoom * perspective) / (u_resolution.y * 0.5);

  float ndc_z = clamp(z_rot * 0.001, -0.99, 0.99);

  gl_Position = vec4(screen_x, screen_y, ndc_z, 1.0);

  float p_size = max(2.0, a_radius * perspective * sqrt(zoom) * 2.0);
  if (a_flags > 1.5) {
    p_size *= 1.5;
  }
  gl_PointSize = p_size;

  v_color = a_color;
  v_flags = a_flags;
}
`;

const POINT_FS = `#version 300 es
precision highp float;

in vec4 v_color;
in float v_flags;

out vec4 fragColor;

void main() {
  vec2 coord = gl_PointCoord - vec2(0.5);
  float dist = length(coord);
  if (dist > 0.5) {
    discard;
  }

  float delta = fwidth(dist);
  float alpha = 1.0 - smoothstep(0.5 - delta, 0.5, dist);

  fragColor = vec4(v_color.rgb, v_color.a * alpha);
}
`;

const LINE_VS = `#version 300 es
precision highp float;

in vec3 a_position;
in vec4 a_color;

uniform vec2 u_resolution;
uniform vec3 u_camera; // yaw, pitch, zoom
uniform float u_scale;

out vec4 v_color;

void main() {
  float yaw = u_camera.x;
  float pitch = u_camera.y;
  float zoom = u_camera.z;

  float x_rot = a_position.x * cos(yaw) + a_position.z * sin(yaw);
  float depth = -a_position.x * sin(yaw) + a_position.z * cos(yaw);
  float y_rot = a_position.y * cos(pitch) - depth * sin(pitch);
  float z_rot = a_position.y * sin(pitch) + depth * cos(pitch);

  float perspective = 650.0 / max(120.0, 650.0 + z_rot * u_scale);

  float screen_x = (x_rot * u_scale * zoom * perspective) / (u_resolution.x * 0.5);
  float screen_y = (y_rot * u_scale * zoom * perspective) / (u_resolution.y * 0.5);
  float ndc_z = clamp(z_rot * 0.001, -0.99, 0.99);

  gl_Position = vec4(screen_x, screen_y, ndc_z, 1.0);
  v_color = a_color;
}
`;

const LINE_FS = `#version 300 es
precision highp float;

in vec4 v_color;
out vec4 fragColor;

void main() {
  fragColor = v_color;
}
`;

function parseHexColor(hex: string, alpha = 1.0): [number, number, number, number] {
  if (hex.startsWith("#")) {
    let clean = hex.slice(1);
    if (clean.length === 3) {
      clean = clean.split("").map((c) => c + c).join("");
    }
    const num = parseInt(clean, 16);
    const r = ((num >> 16) & 255) / 255;
    const g = ((num >> 8) & 255) / 255;
    const b = (num & 255) / 255;
    return [r, g, b, alpha];
  }
  return [0.45, 0.58, 0.68, alpha];
}

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export function MemoryGraph3D({
  nodes,
  edges,
  positions,
  coordinates,
  showTitles,
  selectedNodeId,
  onSelectNode,
  loading,
  resetToken
}: {
  nodes: MemoryGraphNode[];
  edges: MemoryGraphEdge[];
  positions: Map<string, MemoryAtlasPosition>;
  coordinates: Map<string, MemoryPoint3D>;
  showTitles: boolean;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
  loading: boolean;
  resetToken: number;
}) {
  const volumeRatio = useMemo(() => memory3DVolumeRatio([...coordinates.values()]), [coordinates]);
  const containerRef = useRef<HTMLDivElement>(null);
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const textCanvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef<MemoryCamera3D>({ ...DEFAULT_MEMORY_CAMERA });
  const redrawRef = useRef<() => void>(() => {});
  const [webglSupported, setWebglSupported] = useState(true);

  const current = useRef({ nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode });
  current.current = { nodes, edges, positions, coordinates, showTitles, selectedNodeId, onSelectNode };

  useEffect(() => {
    cameraRef.current = { ...DEFAULT_MEMORY_CAMERA };
    redrawRef.current();
  }, [resetToken]);

  useEffect(() => {
    const glCanvas = glCanvasRef.current;
    const textCanvas = textCanvasRef.current;
    if (!glCanvas || !textCanvas) return;

    let gl: WebGL2RenderingContext | null = null;
    try {
      gl = glCanvas.getContext("webgl2", { alpha: true, antialias: true, depth: true });
    } catch {
      gl = null;
    }

    if (!gl) {
      setWebglSupported(false);
      return;
    }

    const pointProgram = createProgram(gl, POINT_VS, POINT_FS);
    const lineProgram = createProgram(gl, LINE_VS, LINE_FS);
    if (!pointProgram || !lineProgram) {
      setWebglSupported(false);
      return;
    }

    const textCtx = textCanvas.getContext("2d");
    if (!textCtx) return;

    // Attribute and uniform locations
    const pointPosLoc = gl.getAttribLocation(pointProgram, "a_position");
    const pointColorLoc = gl.getAttribLocation(pointProgram, "a_color");
    const pointRadiusLoc = gl.getAttribLocation(pointProgram, "a_radius");
    const pointFlagsLoc = gl.getAttribLocation(pointProgram, "a_flags");
    const pointResLoc = gl.getUniformLocation(pointProgram, "u_resolution");
    const pointCamLoc = gl.getUniformLocation(pointProgram, "u_camera");
    const pointScaleLoc = gl.getUniformLocation(pointProgram, "u_scale");

    const linePosLoc = gl.getAttribLocation(lineProgram, "a_position");
    const lineColorLoc = gl.getAttribLocation(lineProgram, "a_color");
    const lineResLoc = gl.getUniformLocation(lineProgram, "u_resolution");
    const lineCamLoc = gl.getUniformLocation(lineProgram, "u_camera");
    const lineScaleLoc = gl.getUniformLocation(lineProgram, "u_scale");

    const nodeVAO = gl.createVertexArray();
    const nodeVBO = gl.createBuffer();

    const lineVAO = gl.createVertexArray();
    const lineVBO = gl.createBuffer();

    let frame = 0;
    let width = 1;
    let height = 1;
    let hover: string | null = null;
    let spatialIndex: SpatialPickingIndex3D | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let dragged = false;
    let downX = 0;
    let downY = 0;

    const render = () => {
      frame = 0;
      if (!gl || gl.isContextLost()) return;
      const { nodes, edges, positions, coordinates, showTitles, selectedNodeId } = current.current;

      gl.viewport(0, 0, glCanvas.width, glCanvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      textCtx.clearRect(0, 0, width, height);

      const extent = Math.max(60, ...[...coordinates.values()].map((p) => Math.hypot(p.x, p.y, p.z)));
      const scale = (Math.min(width, height) * 0.4) / extent;

      const focus = hover ?? selectedNodeId;
      const neighbors = new Set<string>();
      if (focus) {
        for (const edge of edges) {
          if (edge.source === focus) neighbors.add(edge.target);
          if (edge.target === focus) neighbors.add(edge.source);
        }
      }

      // 1. Prepare Line Data
      const lineData: number[] = [];
      for (const edge of edges) {
        const a = coordinates.get(edge.source);
        const b = coordinates.get(edge.target);
        if (!a || !b) continue;

        const incident = edge.source === focus || edge.target === focus;
        let colorHex = edge.type === "DERIVED_FROM" ? "#385068" : "#203343";
        let edgeAlpha = 0.8;
        if (focus) {
          if (incident) {
            colorHex = "#98dafa";
            edgeAlpha = 1.0;
          } else {
            colorHex = "#14202b";
            edgeAlpha = 0.35;
          }
        }
        const [r, g, bCol, aCol] = parseHexColor(colorHex, edgeAlpha);

        lineData.push(a.x, a.y, a.z, r, g, bCol, aCol);
        lineData.push(b.x, b.y, b.z, r, g, bCol, aCol);
      }

      if (lineData.length > 0) {
        gl.useProgram(lineProgram);
        gl.uniform2f(lineResLoc, width, height);
        gl.uniform3f(lineCamLoc, cameraRef.current.yaw, cameraRef.current.pitch, cameraRef.current.zoom);
        gl.uniform1f(lineScaleLoc, scale);

        gl.bindVertexArray(lineVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, lineVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lineData), gl.DYNAMIC_DRAW);

        gl.enableVertexAttribArray(linePosLoc);
        gl.vertexAttribPointer(linePosLoc, 3, gl.FLOAT, false, 7 * 4, 0);

        gl.enableVertexAttribArray(lineColorLoc);
        gl.vertexAttribPointer(lineColorLoc, 4, gl.FLOAT, false, 7 * 4, 3 * 4);

        gl.drawArrays(gl.LINES, 0, lineData.length / 7);
      }

      // 2. Prepare Point Data & Spatial Picking Projection
      const pointData: number[] = [];
      const projectedList: ProjectedMemoryPoint[] = [];
      const projectedMap = new Map<string, { x: number; y: number; z: number; perspective: number }>();

      for (const node of nodes) {
        const coord = coordinates.get(node.id);
        if (!coord) continue;

        const isHighlighted = node.id === focus;
        const isRoot = node.type === "SOURCE" && isMemoryCoreLabel(node.label);
        const isNeighbor = neighbors.has(node.id);

        let flag = 0.0;
        if (isHighlighted) flag = 2.0;
        else if (isRoot) flag = 1.0;
        else if (isNeighbor) flag = 3.0;

        const baseRadius = isRoot ? 10 : node.type === "SOURCE" ? 4.6 : 2.1;
        const colorHex = isHighlighted ? "#ffffff" : positions.get(node.id)?.color ?? "#7395ad";
        const alpha = focus && !isHighlighted && !isNeighbor ? 0.2 : 0.95;
        const [r, g, bCol] = parseHexColor(colorHex);

        pointData.push(coord.x, coord.y, coord.z, r, g, bCol, alpha, baseRadius, flag);

        const proj = projectMemoryPoint(coord, cameraRef.current, scale, width, height);
        projectedMap.set(node.id, proj);
        projectedList.push({
          id: node.id,
          x: proj.x,
          y: proj.y,
          z: proj.z,
          radius: baseRadius,
          perspective: proj.perspective
        });
      }

      if (pointData.length > 0) {
        gl.useProgram(pointProgram);
        gl.uniform2f(pointResLoc, width, height);
        gl.uniform3f(pointCamLoc, cameraRef.current.yaw, cameraRef.current.pitch, cameraRef.current.zoom);
        gl.uniform1f(pointScaleLoc, scale);

        gl.bindVertexArray(nodeVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeVBO);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pointData), gl.DYNAMIC_DRAW);

        gl.enableVertexAttribArray(pointPosLoc);
        gl.vertexAttribPointer(pointPosLoc, 3, gl.FLOAT, false, 9 * 4, 0);

        gl.enableVertexAttribArray(pointColorLoc);
        gl.vertexAttribPointer(pointColorLoc, 4, gl.FLOAT, false, 9 * 4, 3 * 4);

        gl.enableVertexAttribArray(pointRadiusLoc);
        gl.vertexAttribPointer(pointRadiusLoc, 1, gl.FLOAT, false, 9 * 4, 7 * 4);

        gl.enableVertexAttribArray(pointFlagsLoc);
        gl.vertexAttribPointer(pointFlagsLoc, 1, gl.FLOAT, false, 9 * 4, 8 * 4);

        gl.drawArrays(gl.POINTS, 0, pointData.length / 9);
      }

      // 3. Build Sub-Millisecond Spatial Picking Index
      spatialIndex = new SpatialPickingIndex3D(projectedList, 32);

      // 4. Render LOD Titles
      if (showTitles) {
        textCtx.font = "11px system-ui, sans-serif";
        const labels = selectLODLabels(
          nodes,
          projectedMap,
          focus,
          cameraRef.current.zoom,
          width,
          height,
          (t) => textCtx.measureText(t).width,
          40
        );

        for (const b of labels) {
          textCtx.fillStyle = "#09111bea";
          textCtx.fillRect(b.x - 3, b.y - 11, b.w + 6, b.h);
          textCtx.fillStyle = b.isCore ? "#fff0b0" : "#c6dfed";
          textCtx.fillText(b.label, b.x, b.y + 1);
        }
      }

      glCanvas.dataset.rotation = `${cameraRef.current.yaw.toFixed(3)},${cameraRef.current.pitch.toFixed(3)}`;
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };
    redrawRef.current = schedule;

    const resize = () => {
      const rect = glCanvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);

      glCanvas.width = Math.round(width * dpr);
      glCanvas.height = Math.round(height * dpr);

      textCanvas.width = Math.round(width * dpr);
      textCanvas.height = Math.round(height * dpr);
      textCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

      schedule();
    };

    const hit = (x: number, y: number) => spatialIndex?.pick(x, y) ?? null;

    const local = (event: PointerEvent) => {
      const rect = glCanvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const down = (event: PointerEvent) => {
      glCanvas.focus();
      glCanvas.setPointerCapture(event.pointerId);
      const p = local(event);
      pointers.set(event.pointerId, p);
      downX = p.x;
      downY = p.y;
      dragged = false;
      hover = null;
    };

    const move = (event: PointerEvent) => {
      const p = local(event);
      const previous = pointers.get(event.pointerId);
      if (previous) {
        if (Math.hypot(p.x - downX, p.y - downY) > 4) dragged = true;
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== event.pointerId)![1];
          const before = Math.hypot(previous.x - other.x, previous.y - other.y);
          const after = Math.hypot(p.x - other.x, p.y - other.y);
          if (before > 1) {
            cameraRef.current.zoom = Math.max(0.35, Math.min(5, (cameraRef.current.zoom * after) / before));
          }
        } else {
          cameraRef.current.yaw += (p.x - previous.x) * 0.009;
          cameraRef.current.pitch += (p.y - previous.y) * 0.009;
        }
        pointers.set(event.pointerId, p);
      } else {
        hover = hit(p.x, p.y);
        glCanvas.style.cursor = hover ? "pointer" : "grab";
      }
      schedule();
    };

    const up = (event: PointerEvent) => {
      const p = local(event);
      if (!dragged && pointers.size === 1) {
        const id = hit(p.x, p.y);
        if (id) current.current.onSelectNode(id);
      }
      pointers.delete(event.pointerId);
      if (glCanvas.hasPointerCapture(event.pointerId)) {
        glCanvas.releasePointerCapture(event.pointerId);
      }
    };

    const cancel = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      dragged = true;
    };

    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      cameraRef.current.zoom = Math.max(
        0.35,
        Math.min(5, cameraRef.current.zoom * Math.exp(-event.deltaY * 0.001))
      );
      schedule();
    };

    const key = (event: KeyboardEvent) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        cameraRef.current.yaw += event.key === "ArrowLeft" ? -0.15 : event.key === "ArrowRight" ? 0.15 : 0;
        cameraRef.current.pitch += event.key === "ArrowUp" ? -0.15 : event.key === "ArrowDown" ? 0.15 : 0;
        schedule();
      } else if (event.key === "Enter") {
        const node =
          current.current.nodes.find((node) => node.id === current.current.selectedNodeId) ??
          current.current.nodes.find((node) => isMemoryCoreLabel(node.label));
        if (node) current.current.onSelectNode(node.id);
      }
    };

    const onContextLost = (e: Event) => {
      e.preventDefault();
      setWebglSupported(false);
    };

    const onContextRestored = () => {
      setWebglSupported(true);
      schedule();
    };

    glCanvas.addEventListener("webglcontextlost", onContextLost);
    glCanvas.addEventListener("webglcontextrestored", onContextRestored);

    const observer = new ResizeObserver(resize);
    observer.observe(glCanvas);
    resize();

    glCanvas.addEventListener("pointerdown", down);
    glCanvas.addEventListener("pointermove", move);
    glCanvas.addEventListener("pointerup", up);
    glCanvas.addEventListener("pointercancel", cancel);
    glCanvas.addEventListener("wheel", wheel, { passive: false });
    glCanvas.addEventListener("keydown", key);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      redrawRef.current = () => {};
      glCanvas.removeEventListener("webglcontextlost", onContextLost);
      glCanvas.removeEventListener("webglcontextrestored", onContextRestored);
      glCanvas.removeEventListener("pointerdown", down);
      glCanvas.removeEventListener("pointermove", move);
      glCanvas.removeEventListener("pointerup", up);
      glCanvas.removeEventListener("pointercancel", cancel);
      glCanvas.removeEventListener("wheel", wheel);
      glCanvas.removeEventListener("keydown", key);
      gl?.deleteBuffer(nodeVBO);
      gl?.deleteBuffer(lineVBO);
      gl?.deleteVertexArray(nodeVAO);
      gl?.deleteVertexArray(lineVAO);
      gl?.deleteProgram(pointProgram);
      gl?.deleteProgram(lineProgram);
    };
  }, []);

  useEffect(() => {
    redrawRef.current();
  }, [nodes, edges, positions, coordinates, showTitles, selectedNodeId]);

  return (
    <div className="memory-3d-surface" ref={containerRef} style={{ position: "relative", width: "100%", height: "100%" }}>
      <canvas
        ref={glCanvasRef}
        tabIndex={0}
        role="application"
        aria-label="3D memory graph. Drag or use arrow keys to rotate 360 degrees. Scroll or pinch to zoom. Click a node to open."
        aria-busy={loading}
        data-titles-visible={showTitles}
        data-layout-volume={volumeRatio.toFixed(4)}
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      <canvas
        ref={textCanvasRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
          display: showTitles ? "block" : "none"
        }}
      />
      <span className="memory-3d-hint">Drag to rotate 360° · Scroll or pinch to zoom · Click to explore</span>
    </div>
  );
}
