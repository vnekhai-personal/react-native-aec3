#!/usr/bin/env node
// Re-vendors the module's upstream sources into vendor/ (README.md, "Updating"). Downloads
// webrtc-audio-processing and Abseil at the pinned versions and checks each download's size and SHA-256,
// then keeps every file the module's build compiles (cpp/sources.cmake), every header those and the module's
// own sources include on each target the module is built for, the Mac bench's among them (the compiler's own
// dependency output, -M, with each build's defines and C++ standard), and the license and notice files. Writes vendor/MANIFEST.json: the pins, and each kept file's SHA-256, which
// __tests__/native.test.ts checks vendor/ against.
//
//   node scripts/vendor.mjs [--ndk <dir>]           replace vendor/ with a fresh copy
//   node scripts/vendor.mjs --check [--ndk <dir>]   build a copy elsewhere, fail on any difference
//
// Needs a Mac with Xcode (the iOS SDKs) and the Android NDK (default: the newest under
// ~/Library/Android/sdk/ndk). A new upstream version: change PINS, bring cpp/sources.cmake (and the podspec's
// per-architecture lists) in line with its meson files, run this, and build both platforms.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MODULE = ROOT;
const VENDOR = join(MODULE, 'vendor');

/** The upstream releases vendored, and what each download must be. */
const PINS = {
  'webrtc-audio-processing': {
    version: '2.1',
    url: 'https://freedesktop.org/software/pulseaudio/webrtc-audio-processing/webrtc-audio-processing-2.1.tar.xz',
    bytes: 604_192,
    sha256: 'ae9302824b2038d394f10213cab05312c564a038434269f11dbf68f511f9f9fe',
    unpacksTo: 'webrtc-audio-processing-2.1',
  },
  'abseil-cpp': {
    version: '20240722.0',
    url: 'https://github.com/abseil/abseil-cpp/archive/refs/tags/20240722.0.tar.gz',
    bytes: 2_242_861,
    sha256: 'f50e5ac311a81382da7fa75b97310e4b9006474f9560ac46f54a9967f07d4ae3',
    unpacksTo: 'abseil-cpp-20240722.0',
  },
};

/** License and notice files, where each upstream keeps them. */
const NOTICES = {
  'webrtc-audio-processing': [
    'COPYING', 'AUTHORS', 'README.md', 'webrtc/LICENSE', 'webrtc/PATENTS', 'webrtc/third_party/rnnoise/COPYING',
    'webrtc/third_party/pffft/LICENSE', 'webrtc/modules/third_party/fft/LICENSE',
    'webrtc/common_audio/third_party/ooura/LICENSE', 'webrtc/common_audio/third_party/spl_sqrt_floor/LICENSE',
  ],
  'abseil-cpp': ['LICENSE', 'AUTHORS', 'PrivacyInfo.xcprivacy'],
};

const args = process.argv.slice(2);
const check = args.includes('--check');
const ndkArg = args.indexOf('--ndk');

function newestNdk() {
  const base = join(homedir(), 'Library/Android/sdk/ndk');
  const versions = existsSync(base) ? readdirSync(base).filter((name) => /^\d/.test(name)) : [];
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (versions.length === 0) throw new Error(`no Android NDK under ${base}: pass --ndk <dir>`);
  return join(base, versions.at(-1));
}
const NDK = ndkArg >= 0 ? resolve(args[ndkArg + 1] ?? '') : newestNdk();
const NDK_BIN = join(NDK, 'toolchains/llvm/prebuilt/darwin-x86_64/bin');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** cpp/sources.cmake's lists, as the Android build and the podspec compile them. */
const cmake = readFileSync(join(MODULE, 'cpp/sources.cmake'), 'utf8');
const list = (name) => {
  const body = cmake.match(new RegExp(`set\\(${name}\\n([\\s\\S]*?)\\n\\)`))?.[1];
  if (body === undefined) throw new Error(`no ${name} in cpp/sources.cmake`);
  return body.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
};
const common = [...list('WEBRTC_SOURCES'), ...list('WEBRTC_APM_SOURCES').map((source) => `modules/audio_processing/${source}`)];
const neon = list('WEBRTC_NEON_SOURCES');
const sse2 = list('WEBRTC_SSE2_SOURCES');
const avx2 = list('WEBRTC_AVX2_SOURCES');
const android = list('WEBRTC_ANDROID_SOURCES');
const abseil = list('ABSL_SOURCES');

const work = mkdtempSync(join(tmpdir(), 'react-native-aec3-vendor-'));
try {
  const trees = {};
  for (const [name, pin] of Object.entries(PINS)) {
    const response = await fetch(pin.url);
    if (!response.ok) throw new Error(`${pin.url}: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length !== pin.bytes || sha256(archive) !== pin.sha256) {
      throw new Error(`${pin.url}: ${archive.length} bytes, sha256 ${sha256(archive)}; pinned ${pin.bytes}, ${pin.sha256}`);
    }
    const into = join(work, `download-${name}`);
    mkdirSync(into);
    const file = join(into, pin.url.split('/').at(-1));
    writeFileSync(file, archive);
    execFileSync('tar', ['-xf', file, '-C', into]);
    trees[name] = join(into, pin.unpacksTo);
  }
  const WEBRTC = join(trees['webrtc-audio-processing'], 'webrtc');
  const ABSL = trees['abseil-cpp'];

  // Each target the module is built for, with its build's defines and C++ standard (the podspec,
  // android/CMakeLists.txt, bench/CMakeLists.txt): iOS's is C++20, which React Native's pod install sets on
  // every pod. Our own sources are scanned too, for the headers they include that WebRTC's own files do not.
  const sdk = (name) => execFileSync('xcrun', ['--sdk', name, '--show-sdk-path']).toString().trim();
  const base = ['WEBRTC_POSIX', 'WEBRTC_LIBRARY_IMPL', 'WEBRTC_APM_DEBUG_DUMP=0', 'NDEBUG'];
  const ios = ['WEBRTC_MAC', 'WEBRTC_IOS'];
  const droid = ['WEBRTC_ANDROID', 'WEBRTC_LINUX'];
  const ours = ['cpp/rn_aec3.cc'];
  const jni = [...ours, 'android/src/main/cpp/jni_bridge.cc'];
  const bench = [...ours, 'bench/harness.cc'];
  const targets = [
    { name: 'ios-arm64', apple: true, std: 'c++20', args: ['-target', 'arm64-apple-ios16.4', '-isysroot', sdk('iphoneos')], defines: [...ios, 'WEBRTC_ARCH_ARM64', 'WEBRTC_HAS_NEON'], extra: neon, ours },
    { name: 'ios-sim-x86_64', apple: true, std: 'c++20', args: ['-target', 'x86_64-apple-ios16.4-simulator', '-isysroot', sdk('iphonesimulator'), '-mavx2', '-mfma'], defines: [...ios, 'WEBRTC_ENABLE_AVX2'], extra: [...sse2, ...avx2], ours },
    { name: 'android-arm64', std: 'c++17', args: ['--target=aarch64-linux-android24'], defines: [...droid, 'WEBRTC_ARCH_ARM64', 'WEBRTC_HAS_NEON'], extra: [...neon, ...android], ours: jni },
    { name: 'android-armv7', std: 'c++17', args: ['--target=armv7a-linux-androideabi24', '-mfpu=neon'], defines: [...droid, 'WEBRTC_HAS_NEON'], extra: [...neon, ...android], ours: jni },
    { name: 'android-x86_64', std: 'c++17', args: ['--target=x86_64-linux-android24'], defines: [...droid, 'WEBRTC_ENABLE_AVX2'], extra: [...sse2, ...avx2, ...android], avx2: true, ours: jni },
    { name: 'android-x86', std: 'c++17', args: ['--target=i686-linux-android24', '-msse2'], defines: [...droid, 'WEBRTC_ENABLE_AVX2'], extra: [...sse2, ...avx2, ...android], avx2: true, ours: jni },
    { name: 'macos-arm64', apple: true, std: 'c++17', args: ['-target', 'arm64-apple-macos13', '-isysroot', sdk('macosx')], defines: ['WEBRTC_MAC', 'WEBRTC_ARCH_ARM64', 'WEBRTC_HAS_NEON'], extra: neon, ours: bench },
    { name: 'macos-x86_64', apple: true, std: 'c++17', args: ['-target', 'x86_64-apple-macos13', '-isysroot', sdk('macosx'), '-msse2'], defines: ['WEBRTC_MAC', 'WEBRTC_ENABLE_AVX2'], extra: [...sse2, ...avx2], avx2: true, ours: bench },
  ];

  const headers = { webrtc: new Set(), absl: new Set() };
  for (const target of targets) {
    const sources = [
      ...[...common, ...target.extra].map((source) => join(WEBRTC, source)), ...abseil.map((source) => join(ABSL, source)),
      ...target.ours.map((source) => join(MODULE, source)),
    ];
    for (const source of sources) {
      const c = source.endsWith('.c');
      const [tool, pre] = target.apple ? ['xcrun', [c ? 'clang' : 'clang++']] : [join(NDK_BIN, c ? 'clang' : 'clang++'), []];
      const flags = [
        ...pre, ...target.args, c ? '-std=c11' : `-std=${target.std}`,
        ...(target.avx2 && avx2.some((kernel) => source.endsWith(kernel)) ? ['-mavx2', '-mfma'] : []),
        '-M', '-w', `-I${WEBRTC}`, `-I${ABSL}`, `-I${join(MODULE, 'cpp')}`, ...[...base, ...target.defines].map((define) => `-D${define}`), source,
      ];
      const deps = execFileSync(tool, flags, { maxBuffer: 64 * 1024 * 1024 }).toString();
      for (const path of deps.replace(/\\\n/g, ' ').split(/\s+/)) {
        if (path.startsWith(`${WEBRTC}/`) && !/\.cc?$/.test(path)) headers.webrtc.add(relative(WEBRTC, path));
        if (path.startsWith(`${ABSL}/`) && !path.endsWith('.cc')) headers.absl.add(relative(ABSL, path));
      }
    }
    console.error(`${target.name}: ${headers.webrtc.size} WebRTC and ${headers.absl.size} Abseil headers so far`);
  }

  // The copy, in a folder of its own.
  const staged = join(work, 'vendor');
  const keep = (tree, path, into) => {
    mkdirSync(dirname(join(staged, into, path)), { recursive: true });
    copyFileSync(join(tree, path), join(staged, into, path));
  };
  const webrtcTree = trees['webrtc-audio-processing'];
  for (const source of [...common, ...neon, ...sse2, ...avx2, ...android]) keep(webrtcTree, `webrtc/${source}`, 'webrtc-audio-processing');
  for (const header of headers.webrtc) keep(webrtcTree, `webrtc/${header}`, 'webrtc-audio-processing');
  for (const notice of NOTICES['webrtc-audio-processing']) keep(webrtcTree, notice, 'webrtc-audio-processing');
  for (const path of [...abseil, ...headers.absl, ...NOTICES['abseil-cpp']]) keep(ABSL, path, 'abseil-cpp');

  const manifest = {
    sources: Object.fromEntries(Object.entries(PINS).map(([name, { version, url, bytes, sha256: hash }]) => [name, { version, url, bytes, sha256: hash }])),
    files: Object.fromEntries(filesUnder(staged).sort().map((path) => [path, sha256(readFileSync(join(staged, path)))])),
  };
  writeFileSync(join(staged, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const count = Object.keys(manifest.files).length;

  if (check) {
    const differences = compare(staged, VENDOR);
    for (const line of differences) console.log(line);
    console.log(differences.length === 0 ? `vendor/ is upstream's: ${count} files and the manifest` : `${differences.length} differences`);
    process.exitCode = differences.length === 0 ? 0 : 1;
  } else {
    rmSync(VENDOR, { recursive: true, force: true });
    cpSync(staged, VENDOR, { recursive: true });
    console.log(`vendor/: ${count} files and MANIFEST.json`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** Every file under `dir`, relative to it, with `/` between folders. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'));
}

/** What differs between the fresh copy and vendor/: a file only in one, or different bytes. */
function compare(fresh, current) {
  const ours = new Set(existsSync(current) ? filesUnder(current) : []);
  const theirs = new Set(filesUnder(fresh));
  const differences = [];
  for (const path of theirs) {
    if (!ours.has(path)) differences.push(`missing from vendor/: ${path}`);
    else if (sha256(readFileSync(join(fresh, path))) !== sha256(readFileSync(join(current, path)))) differences.push(`changed: ${path}`);
  }
  for (const path of ours) if (!theirs.has(path)) differences.push(`not upstream's: ${path}`);
  return differences;
}
