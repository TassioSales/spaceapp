/**
 * Container engine abstraction for SpaceApp launcher.
 *
 * The launcher historically assumed Docker. This module keeps the
 * abstraction thin and explicit: supported engines are enumerated,
 * engine-aware commands are constructed, and runtime probes are
 * factored so callers (doctor, prerequisites, install) can stay
 * engine-agnostic.
 */

export const SUPPORTED_ENGINES = Object.freeze(["docker", "podman"]);

export function isSupportedEngine(value) {
  return SUPPORTED_ENGINES.includes(value);
}

export function normalizeEngine(value) {
  const engine = value?.toString().trim().toLowerCase();
  if (!isSupportedEngine(engine)) {
    throw new Error(`Unsupported SpaceApp container engine "${value}". Choose docker or podman.`);
  }
  return engine;
}

export function composeBinary(engine) {
  return normalizeEngine(engine);
}

export function engineProbeSpecs(engine) {
  const binary = composeBinary(engine);
  return [
    { name: `${binary} CLI`, command: binary, args: ["--version"] },
    { name: `${binary} Compose`, command: binary, args: ["compose", "version"] },
    { name: `${binary} Engine`, command: binary, args: ["info"] }
  ];
}

export function engineVersionFlags(engine) {
  const binary = composeBinary(engine);
  return {
    command: binary,
    args: ["--version"]
  };
}

export function engineComposeVersionFlags(engine) {
  const binary = composeBinary(engine);
  return {
    command: binary,
    args: ["compose", "version"]
  };
}

export function engineInfoFlags(engine) {
  const binary = composeBinary(engine);
  return {
    command: binary,
    args: ["info"]
  };
}

const VERSION_LINE = /^(?:Docker|podman) version\s+(\d+\.\d+\.\d+).*$/im;

export function parseEngineVersion(output = "") {
  const match = output.match(VERSION_LINE);
  return match ? match[1] : null;
}

const MIN_PODMAN_VERSION = "5.0.0";

function compareVersions(a, b) {
  const parse = (v) => v.split(".").map(Number);
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const diff = (aa[i] || 0) - (bb[i] || 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export function isPodmanVersionSupported(version) {
  return typeof version === "string" && compareVersions(version, MIN_PODMAN_VERSION) >= 0;
}

export function minimumPodmanVersion() {
  return MIN_PODMAN_VERSION;
}

/**
 * Validate the installed Podman version is at least the documented minimum.
 * Returns false when the CLI is unavailable or the version cannot be parsed.
 */
export async function validatePodmanVersion(execute) {
  const spec = engineVersionFlags("podman");
  let output = "";
  const { Writable } = await import("node:stream");
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    }
  });
  const code = await execute(spec, { stdout, stderr: null });
  if (code !== 0) return false;
  return isPodmanVersionSupported(parseEngineVersion(output));
}

/**
 * Detect the first engine that is available on PATH and responsive.
 * Docker is preferred when both are present to preserve existing behaviour.
 */
export async function detectAvailableEngine(execute, options = {}) {
  for (const engine of SUPPORTED_ENGINES) {
    const specs = engineProbeSpecs(engine);
    const available = (
      await execute(specs[0], { stdout: null, stderr: null }) === 0 &&
      await execute(specs[1], { stdout: null, stderr: null }) === 0 &&
      await execute(specs[2], { stdout: null, stderr: null }) === 0
    );
    if (available) return engine;
  }
  return null;
}

export function defaultEngine() {
  return "docker";
}

/**
 * Inspect a Podman machine (macOS/Windows VM). Returns null when the CLI or
 * machine is unavailable. An empty name inspects the default machine.
 */
export async function inspectPodmanMachine(execute, name = "") {
  const args = ["machine", "inspect", "--format", "{{json .}}"];
  if (name) args.push(name);
  const output = await captureProbe(execute, { command: "podman", args });
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/**
 * List Podman machines. Returns an empty array when the CLI is unavailable.
 */
export async function listPodmanMachines(execute) {
  const output = await captureProbe(execute, { command: "podman", args: ["machine", "list", "--format", "json"] });
  if (!output) return [];
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Extract CPU, memory and disk limits from a Podman machine inspect object.
 * Returns null for missing or unexpected structures.
 */
export function podmanMachineResourceInfo(machine) {
  if (!machine || typeof machine !== "object") return null;
  const resources = machine.Resources && typeof machine.Resources === "object" ? machine.Resources : {};
  const cpus = Number(resources.CPUs ?? machine.CPUs ?? machine.cpus);
  const memoryBytes = parseByteSize(resources.Memory ?? machine.Memory ?? machine.memory);
  const diskSize = resources.DiskSize ?? machine.DiskSize ?? machine.diskSize ?? machine.ImageVolumeSize ?? machine.imageVolumeSize;
  // Podman machine inspect reports numeric DiskSize in GiB (Memory is MiB).
  const diskBytes = typeof diskSize === "number" ? Math.floor(diskSize * 1024 ** 3) : parseByteSize(diskSize);
  if (!Number.isFinite(cpus) || cpus <= 0) return null;
  if (!Number.isFinite(memoryBytes) || memoryBytes <= 0) return null;
  if (!Number.isFinite(diskBytes) || diskBytes <= 0) return null;
  return {
    cpuCount: cpus,
    memoryBytes,
    diskBytes
  };
}

function parseByteSize(value) {
  // Numeric values follow the podman machine inspect convention for memory: MiB.
  if (typeof value === "number") return Math.floor(value * 1024 ** 2);
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const match = /^([\d.]+)\s*([kmgtp]?i?b?)?$/.exec(trimmed);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const unit = match[2] || "b";
  const multipliers = {
    b: 1,
    k: 1024, kb: 1000, kib: 1024,
    m: 1024 ** 2, mb: 1000 ** 2, mib: 1024 ** 2,
    g: 1024 ** 3, gb: 1000 ** 3, gib: 1024 ** 3,
    t: 1024 ** 4, tb: 1000 ** 4, tib: 1024 ** 4
  };
  return Math.floor(number * (multipliers[unit] ?? 1));
}

async function captureProbe(execute, spec) {
  let output = "";
  const { Writable } = await import("node:stream");
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      if (output.length < 1024 * 1024) output += chunk.toString();
      done();
    }
  });
  try {
    const code = await execute(spec, { stdout, stderr: null });
    return code === 0 ? output.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Human-readable resize guidance for a Podman machine.
 */
export function podmanMachineResizeGuidance(name, profile = "small") {
  const target = name ? ` ${name}` : "";
  const reqCpu = profile === "large" ? 8 : 4;
  const reqMemoryMiB = profile === "large" ? 15360 : (profile === "medium" ? 11264 : 8192);
  const reqDiskGiB = profile === "large" ? 40 : (profile === "medium" ? 30 : 25);
  return [
    `Resize the Podman machine with: podman machine set${target} --cpus ${reqCpu} --memory ${reqMemoryMiB} --disk-size ${reqDiskGiB}`,
    "Stop the machine first if the command reports it is running: podman machine stop" + target,
    "Units are MiB for --memory and GiB for --disk-size. Start the machine afterwards: podman machine start" + target
  ].join("\n");
}

export async function inspectEngineDetails(engine, execute) {
  const binary = composeBinary(engine);
  const versionSpec = engineVersionFlags(engine);
  const infoSpec = { command: binary, args: ["info", "--format", "{{json .}}"] };
  
  let versionOutput = "";
  let infoOutput = "";
  const { Writable } = await import("node:stream");
  const vStdout = new Writable({
    write(chunk, _enc, done) { versionOutput += chunk.toString(); done(); }
  });
  const iStdout = new Writable({
    write(chunk, _enc, done) { infoOutput += chunk.toString(); done(); }
  });
  
  const vCode = await execute(versionSpec, { stdout: vStdout, stderr: null }).catch(() => 1);
  const iCode = await execute(infoSpec, { stdout: iStdout, stderr: null }).catch(() => 1);
  
  const version = parseEngineVersion(versionOutput) || "unknown";
  let parsedInfo = null;
  try {
    parsedInfo = JSON.parse(infoOutput);
  } catch {}
  
  if (engine === "podman") {
    const host = parsedInfo?.host || parsedInfo?.Host || {};
    const rootless = host.security?.rootless ?? (typeof process.getuid === "function" ? process.getuid() !== 0 : true);
    const cgroupVersion = host.cgroupVersion || host.cgroupsVersion || (process.platform === "linux" ? "v2" : "n/a");
    const controllers = Array.isArray(host.cgroupControllers) ? host.cgroupControllers : [];
    const isLinux = process.platform === "linux";
    const limitsDelegated = !isLinux || (cgroupVersion === "v2" && controllers.includes("cpu") && controllers.includes("memory"));
    const versionOk = isPodmanVersionSupported(version);
    return {
      engine: "podman",
      version,
      versionOk,
      rootless,
      cgroupVersion,
      limitsDelegated,
      available: vCode === 0 && iCode === 0
    };
  } else {
    const rootless = Array.isArray(parsedInfo?.SecurityOptions) && parsedInfo.SecurityOptions.some((opt) => opt.includes("rootless"));
    const cgroupVersion = parsedInfo?.CgroupVersion ? `v${parsedInfo.CgroupVersion}` : (process.platform === "linux" ? "v2" : "n/a");
    const limitsDelegated = parsedInfo?.MemoryLimit !== false && parsedInfo?.CPUShares !== false;
    return {
      engine: "docker",
      version,
      versionOk: vCode === 0,
      rootless,
      cgroupVersion,
      limitsDelegated,
      available: vCode === 0 && iCode === 0
    };
  }
}
