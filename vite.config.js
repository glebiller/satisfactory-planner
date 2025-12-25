import { resolve } from 'path'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/satisfactory-planner/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        transformations: resolve(__dirname, 'transformations.html'),
      },
    },
  },
});
