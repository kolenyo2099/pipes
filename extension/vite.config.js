import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ONNX dynamically imports its loader. Ship that module and WASM locally rather
// than allowing the library's default CDN URL in a Manifest V3 extension.
function nlpRuntime() {
  const directory = dirname(fileURLToPath(import.meta.resolve('onnxruntime-web')))
  const files = ['ort-wasm-simd-threaded.jsep.mjs']
  return {
    name: 'canary-nlp-runtime',
    generateBundle() {
      for (const file of files) this.emitFile({ type: 'asset', fileName: `nlp-runtime/${file}`, source: readFileSync(join(directory, file)) })
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = request.url?.split('?')[0].replace(/^\/nlp-runtime\//, '')
        if (!request.url?.startsWith('/nlp-runtime/') || !files.includes(file)) return next()
        response.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        response.end(readFileSync(join(directory, file)))
      })
    },
  }
}

// Builds the Chrome extension into dist/: the app page, the offscreen collector page, and public/ as-is
// (manifest.json, background.js, icon, GKG theme list). Load dist/ with "Load unpacked" in chrome://extensions.
export default defineConfig({
  base: './',
  plugins: [svelte(), nlpRuntime()],
  resolve: { conditions: ['browser'] },
  build: {
    target: 'es2022',
    rollupOptions: { input: { index: 'index.html', offscreen: 'offscreen.html' } },
  },
  worker: { format: 'es' },
  server: { host: '127.0.0.1' },
})
