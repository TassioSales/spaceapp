import { layoutMemoryNetwork3DStream } from "./memory-3d.js";
import { layoutMemoryNetwork } from "./memory-network-layout.js";
import type { MemoryGraphNode, MemoryGraphEdge } from "@space/contracts";

self.onmessage = (event: MessageEvent<{ nodes: MemoryGraphNode[]; edges: MemoryGraphEdge[] }>) => {
  const positions = layoutMemoryNetwork(event.data.nodes, event.data.edges);

  const depth = layoutMemoryNetwork3DStream(
    event.data.nodes,
    event.data.edges,
    (intermediateDepth, step, totalSteps) => {
      self.postMessage({
        type: step === totalSteps ? "done" : "progress",
        positions: [...positions],
        depth: [...intermediateDepth],
        step,
        totalSteps,
      });
    },
    30
  );

  // For compatibility with any listener expecting immediate final payload
  self.postMessage({
    type: "done",
    positions: [...positions],
    depth: [...depth],
    step: 180,
    totalSteps: 180,
  });
};
