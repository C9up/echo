/**
 * `ream configure @c9up/echo` — wire the cache in one command.
 *
 * The provider alone is not enough: it reads `config/cache.ts`, and a package
 * registered without one falls back to a default that is rarely the one an
 * application wants. Writing both together is what makes `ream add` mean
 * installed AND working.
 */

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
}

export async function configure(codemods: Codemods): Promise<void> {
	await codemods.addProvider("@c9up/echo/provider");
	await codemods.writeFile(
		"config/cache.ts",
		`import { defineConfig, drivers, store } from '@c9up/echo'
import env from '#start/env'

export default defineConfig({
  default: env.get('CACHE_STORE', 'memory'),

  stores: {
    // One layer, in this process.
    memory: store().useL1Layer(drivers.memory({ maxItems: 1000 })),

    // Two layers: memory in front of Redis, with a bus so every instance
    // drops its own L1 entry when another writes.
    tiered: store()
      .useL1Layer(drivers.memory({ maxItems: 1000 }))
      .useL2Layer(drivers.redis({ connection: 'main' }))
      .useBus(drivers.redisBus({ connection: 'main' })),
  },
})`,
	);
}
