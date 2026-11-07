import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const MODULE = join(__dirname, "..");
const VENDOR = join(MODULE, "vendor");

const source = (path: string) => readFileSync(join(MODULE, path), "utf8");

/** What `scripts/vendor.mjs` wrote: the upstream releases, and each vendored file's SHA-256. */
const manifest = JSON.parse(readFileSync(join(VENDOR, "MANIFEST.json"), "utf8")) as {
  sources: Record<string, { version: string }>;
  files: Record<string, string>;
};

/** Every file under `dir`, relative to it, with `/` between folders. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"));
}

describe("the module's audio memory", () => {
  // process works in the typed arrays' own memory, valid only while JavaScript waits for the call
  // (README.md, "The audio's memory"): an AsyncFunction would let JavaScript change or collect them while
  // native code still reads and writes them.
  it.each([
    ["iOS", "ios/Aec3Module.swift"],
    ["Android", "android/src/main/java/com/reactnativeaec3/Aec3Module.kt"],
  ])("keeps process a synchronous function on %s", (_platform, path) => {
    const code = source(path);
    expect(code).toMatch(/\bFunction\("process"\)/);
    expect(code).not.toMatch(/AsyncFunction\("process"\)/);
  });
});

describe("the module's buffers", () => {
  // The audio lives in buffers native code owns and shares with JavaScript; process takes a frame count only. No
  // pointer, length or offset from JavaScript reaches native memory on either platform (CLAUDE.md, "Rules this code keeps").
  it("are owned by native code and shared, with process taking only a frame count, on both platforms", () => {
    const kotlin = source("android/src/main/java/com/reactnativeaec3/Aec3Module.kt");
    expect(kotlin).toMatch(/Function\("captureBuffer"\)/);
    expect(kotlin).toMatch(/Function\("process"\) \{ canceller: EchoCanceller, frames: Double ->/);
    expect(kotlin).toMatch(/ByteBuffer\.allocateDirect/);
    expect(kotlin).not.toMatch(/JavaScriptArrayBuffer|Float32Array|toDirectBuffer/);
    const jni = source("android/src/main/cpp/jni_bridge.cc");
    expect(jni).toMatch(/GetDirectBufferCapacity\(capture\)/);
    const swift = source("ios/Aec3Module.swift");
    expect(swift).toMatch(/Function\("captureBuffer"\)/);
    expect(swift).toMatch(/Function\("process"\) \{ \(canceller: EchoCanceller, frames: Double\)/);
    expect(swift).toMatch(/ArrayBuffer\(size:/);
    expect(swift).not.toMatch(/rawPointer|Float32Array/);
  });
});

describe("the vendored sources", () => {
  // Upstream's, never edited by hand: a change here is a re-vendor, `node scripts/vendor.mjs`, which
  // writes the manifest this reads.
  it("are exactly the files their manifest lists, byte for byte", () => {
    const files = filesUnder(VENDOR).filter((path) => path !== "MANIFEST.json").sort();
    expect(files).toEqual(Object.keys(manifest.files).sort());
    const changed = files.filter((path) => createHash("sha256").update(readFileSync(join(VENDOR, path))).digest("hex") !== manifest.files[path]);
    expect(changed).toEqual([]);
  });

  it("are the release the README names", () => {
    expect(source("README.md")).toContain(`webrtc-audio-processing ${manifest.sources["webrtc-audio-processing"]?.version}`);
  });

  // react-native-audio-api compiles its own pffft into the same iOS app, and the linker keeps one of two
  // definitions of a name without a word, so ours goes by names of our own there (the podspec).
  it("rename every function pffft.c defines, on iOS", () => {
    const pffft = source("vendor/webrtc-audio-processing/webrtc/third_party/pffft/src/pffft.c");
    // A definition starts its line. Static and inline ones stay in the file, and the _nosimd ones are
    // compiled only without SIMD, under the plain names.
    const defined = [...pffft.matchAll(/^(?!static\b|inline\b)[A-Za-z_][\w *]*?\b(\w+)\s*\(/gm)]
      .map((match) => match[1]!)
      .filter((name) => !name.endsWith("_nosimd"));
    const renamed = /pffft = %w\[([^\]]*)\]/.exec(source("ReactNativeAec3.podspec"))?.[1]?.trim().split(/\s+/) ?? [];
    expect([...renamed].sort()).toEqual([...new Set(defined)].sort());
  });

  it("list the files the builds compile", () => {
    // Every source cpp/sources.cmake names must be vendored, or a build fails on a missing file.
    const cmake = source("cpp/sources.cmake");
    const list = (name: string) =>
      (cmake.match(new RegExp(`set\\(${name}\\n([\\s\\S]*?)\\n\\)`))?.[1] ?? "")
        .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    const webrtc = [
      ...list("WEBRTC_SOURCES"), ...list("WEBRTC_APM_SOURCES").map((path) => `modules/audio_processing/${path}`),
      ...list("WEBRTC_NEON_SOURCES"), ...list("WEBRTC_SSE2_SOURCES"), ...list("WEBRTC_AVX2_SOURCES"), ...list("WEBRTC_ANDROID_SOURCES"),
    ].map((path) => `webrtc-audio-processing/webrtc/${path}`);
    const abseil = list("ABSL_SOURCES").map((path) => `abseil-cpp/${path}`);
    const missing = [...webrtc, ...abseil].filter((path) => !(path in manifest.files));
    expect(missing).toEqual([]);
  });
});
