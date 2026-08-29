# @c9up/echo

> Pluggable cache contract for the Ream framework, with memory + Redis drivers.

Part of **[Ream](https://github.com/C9up/ream)** — a Rust-powered, AdonisJS-compatible Node.js framework. Independent, publishable package.

## Installation

```bash
pnpm add @c9up/echo
ream configure @c9up/echo
```

## Usage

Register the provider, then name the cache stores in `config/cache.ts`:

```ts
// reamrc.ts
providers: [
  () => import('@c9up/echo/provider'),
]
```

```ts
// config/cache.ts
import { defineConfig, drivers, store } from '@c9up/echo'
import env from '#start/env'

export default defineConfig({
  default: env.get('CACHE_STORE'),
  stores: {
    memory: store().useL1Layer(drivers.memory()),

    tiered: store({ ttl: 60 })
      .useL1Layer(drivers.memory())
      .useL2Layer(drivers.redis({ connection: 'main' })),
  },
})
```

```ts
import cache from '@c9up/echo/services/main'

await cache.set({ key: 'user:1', value: user })
await cache.use('tiered').get({ key: 'user:1' })
```

A store is described a layer at a time: **L1** is the fast one (memory), **L2**
the shared one (Redis) — what makes the cache survive a restart. With both, a
read hits L1, a miss falls to L2, and a write reaches both. `useBus()` keeps
each instance's L1 in step after a write, and needs two layers to mean
anything.

Stores are built on first use, so naming a Redis store in an environment that
runs on memory opens no connection.

The plain `{ driver: drivers.memory(), ttl: 60 }` form is still accepted for
configs written against it.

## Entry points

- `@c9up/echo` — main API
- `@c9up/echo/provider` — Ream IoC provider
- `@c9up/echo/services/main` — container service accessor

## License

MIT
