import { defineConfig } from "vite"

// Static build: the app reads Arkiv straight from the browser, so there is no server to deploy.
export default defineConfig({
  root: "web",
  envDir: "..",
  // Only VITE_* variables reach the bundle. ARKIV_PRIVATE_KEY is never exposed.
  envPrefix: "VITE_",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
})
