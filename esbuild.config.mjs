import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { readFile } from "fs/promises";

const prod = process.argv[2] === "production";

// @xenova/transformers requires several native modules unconditionally even though
// the Electron renderer only uses the WASM (onnxruntime-web) path.
// Stub them out so the require() calls don't throw at runtime.
const stubNativeModules = {
  name: "stub-native-modules",
  setup(build) {
    const stubs = /^(onnxruntime-node|sharp|canvas)$/;
    build.onResolve({ filter: stubs }, (args) => ({
      path: args.path,
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: "module.exports = {};",
      loader: "js",
    }));
  },
};

// In Electron's renderer process, process.release.name === "node" is true, which
// causes @xenova/transformers to select the onnxruntime-node backend (our stub).
// Patch onnx.js at build time to always use the WASM/web backend instead.
const forceOnnxWeb = {
  name: "force-onnx-web",
  setup(build) {
    build.onLoad({ filter: /backends\/onnx\.js$/ }, async (args) => {
      let source = await readFile(args.path, "utf8");
      source = source.replace(
        "process?.release?.name === 'node'",
        "false"
      );
      return { contents: source, loader: "js" };
    });
  },
};

// ort-web detects Node.js via process.versions.node and uses threaded WASM + worker_threads,
// which fails in Electron's renderer. Force browser mode so it uses non-threaded WASM instead.
const forceOrtWebBrowserMode = {
  name: "force-ort-web-browser-mode",
  setup(build) {
    build.onLoad({ filter: /ort-web\.min\.js$/ }, async (args) => {
      let source = await readFile(args.path, "utf8");
      // Replace all three occurrences of the Node.js version check
      source = source.replaceAll(
        '"string"==typeof process.versions.node',
        "false"
      );
      return { contents: source, loader: "js" };
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  plugins: [stubNativeModules, forceOnnxWeb, forceOrtWebBrowserMode],
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins,
  ],
  format: "cjs",
  target: "es2020", // raised from es2018 to support BigInt used by @xenova/transformers
  // @xenova/transformers uses import.meta.url to locate its own files.
  // In CJS output, esbuild stubs import.meta as {}, making fileURLToPath(undefined) throw.
  // Provide a valid dummy URL so init_env() can complete and env.backends is populated.
  define: { "import.meta.url": '"file:///obsidian-bundle.js"' },
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
