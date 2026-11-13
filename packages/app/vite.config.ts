import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/** The app talks to the Worker on the same origin. In development Vite forwards the API, sign-in and sockets to it. */
const worker = process.env.WORK_URL ?? "http://localhost:8787"

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: worker, ws: true },
      "/auth": { target: worker },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
})
