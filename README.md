# @c9up/echo

> Pluggable cache contract for the Ream framework, with memory + Redis drivers.

Part of **[Ream](https://github.com/C9up/ream)** — a Rust-powered, AdonisJS-compatible Node.js framework. Independent, publishable package.

## Installation

```bash
pnpm add @c9up/echo
ream configure @c9up/echo
```

## Usage

Register the provider in your app, then configure it under `config/echo.ts`:

```ts
// reamrc.ts
providers: [
  () => import('@c9up/echo/provider'),
]
```

## Entry points

- `@c9up/echo` — main API
- `@c9up/echo/provider` — Ream IoC provider
- `@c9up/echo/services/main` — container service accessor

## License

MIT
