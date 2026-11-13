# Contributing to Traceback CLI

Thank you for your interest in contributing to the Traceback CLI!

## Development Setup

### Prerequisites

- Node.js >= 18.0.0
- pnpm (recommended) or npm

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/TracebackAI/cli.git
   cd cli
   ```
2. Install dependencies:
   ```bash
   pnpm install
   ```

### Development Scripts

- **Build:** `pnpm build` (compiles TypeScript via `tsup` into `dist/`)
- **Dev mode:** `pnpm dev` (watches for changes and rebuilds automatically)
- **Typecheck:** `pnpm typecheck`
- **Lint:** `pnpm lint` or `pnpm lint:fix`
- **Format:** `pnpm format` or `pnpm format:fix`
- **Test:** `pnpm test` or `pnpm test:watch`
- **Link locally for testing:** `npm link` (lets you run `traceback` in your terminal from your local build)

## Pull Request Guidelines

1. Ensure all tests pass (`pnpm test`).
2. Ensure TypeScript compilation passes without errors (`pnpm typecheck`).
3. Adhere to ESLint and Prettier formatting (`pnpm lint` and `pnpm format`).
4. Write clear commit messages and PR descriptions describing what changed.
