import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        // The game.
        main: 'index.html',
        // Dev demo pages, published alongside it so they can be opened from a phone.
        sceneDemo: 'src/render/scene/demo.html',
        fxDemo: 'src/render/fx/demo.html',
        viewmodelDemo: 'src/render/viewmodel/demo.html',
        audioDemo: 'src/audio/demo.html',
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
  },
});
