import { defineConfig } from 'vite';
import { builtinModules } from 'module';
import path from 'path';

export default defineConfig({
	build: {
		lib: {
			entry: path.resolve(__dirname, 'main.ts'),
			formats: ['cjs'],
		},
		rollupOptions: {
			output: {
				entryFileNames: 'main.js',
				assetFileNames: 'styles.css',
			},
			external: [
				'obsidian',
				'electron',
				...builtinModules,
				...builtinModules.map((m) => `node:${m}`),
			],
		},
		outDir: '.',
		emptyOutDir: false,
		sourcemap: 'inline',
	},
});
