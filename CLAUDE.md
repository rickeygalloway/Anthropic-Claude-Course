# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

UIGen is an AI-powered React component generator. Users describe components in natural language; Claude uses tool calls to generate/edit files in a virtual file system, which are then previewed live in the browser.

## Commands

```bash
npm run dev          # Start dev server (Turbopack)
npm run build        # Production build (requires node-compat.cjs polyfill via NODE_OPTIONS)
npm run lint         # ESLint
npm run test         # Run all Vitest tests
npm run setup        # Install deps + generate Prisma client + run migrations
npm run db:reset     # Reset the SQLite database
```

To run a single test file:
```bash
npx vitest run src/lib/__tests__/file-system.test.ts
```

Background dev server (logs to `logs.txt`):
```bash
npm run dev:daemon
```

## Architecture

### Application Layout

Three-panel resizable UI (split left/right):
- **Left (35%)**: Chat interface — user messages + AI streaming responses
- **Right (65%)**: Tabbed preview frame / Monaco code editor with file tree

State flows through two nested React contexts (both wrapping the entire UI):
1. `FileSystemProvider` (outer) — manages the virtual in-memory file system
2. `ChatProvider` (inner) — manages chat messages, AI streaming, and tool execution

### AI Integration

**Entry point**: `POST /api/chat` (`src/app/api/chat/route.ts`)

The API route streams responses from Claude using Vercel AI SDK. Claude has two tools:
- `str_replace_editor` — view/replace/insert content in virtual files (`src/lib/tools/str-replace.ts`). Supports commands: `view`, `create`, `str_replace`, `insert`. (`undo_edit` is accepted but returns an error.)
- `file_manager` — rename/delete files and directories (`src/lib/tools/file-manager.ts`)

Note: these tools use different SDK patterns — `str_replace_editor` is a plain object with an `execute` function; `file_manager` uses the Vercel AI SDK `tool()` helper.

Tool calls are handled on the client side via `ChatProvider`, which calls into `FileSystemContext` to mutate virtual file state. The server reconstructs the `VirtualFileSystem` fresh from serialized client state on every request — there is no server-side file system.

**Provider selection** (`src/lib/provider.ts`): If `ANTHROPIC_API_KEY` is set, uses real Claude (`claude-haiku-4-5`, maxSteps: 40). Otherwise falls back to a `MockLanguageModel` that simulates a 4-step component generation sequence (maxSteps: 4) — useful for development without an API key. The mock detects component type from prompt keywords ("form", "card", or default "counter").

**System prompt** (`src/lib/prompts/generation.tsx`) key constraints for Claude:
- Must create `/App.jsx` as the entry point
- Use Tailwind CSS exclusively (no hardcoded styles)
- Use `@/` import alias for all local imports
- No HTML files — JSX only

The system prompt is sent with Anthropic cache control (`ephemeral`) to reduce API costs.

### Virtual File System

`src/lib/file-system.ts` — pure in-memory tree using `Map<string, FileNode>`. No disk I/O. Supports nested dirs, CRUD operations, and string editor commands (`viewFile`, `replaceInFile`, `insertInFile`). Serializes to JSON for database persistence (`serialize()` / `deserializeFromNodes()`).

Key behaviors:
- `createFile()` auto-creates missing parent directories
- Renaming a directory updates all child paths in the Map
- Deleting a directory recursively removes all children
- Root `/` cannot be deleted or renamed

### Preview Iframe

`src/components/preview/PreviewFrame.tsx` — renders the virtual file system into a sandboxed iframe.

Entry point search priority: `/App.jsx` → `/App.tsx` → `/index.jsx` → `/index.tsx` → `/src/App.jsx` → first `.jsx/.tsx` file found.

`FileSystemContext` uses a `refreshTrigger` counter (incremented on every file mutation) to signal re-renders without full state replacement.

The iframe requires `allow-same-origin` sandbox attribute because the import map uses blob URLs (without it, blob URL imports would fail).

### Code Transformation

`src/lib/transform/jsx-transformer.ts` — two-pass pipeline running in the browser via `@babel/standalone`:

1. **Transform pass**: Transpiles all JSX/TSX/TS files, strips CSS imports (collected separately), returns transformed code + import paths
2. **Import map pass**: Resolves imports — local files become blob URLs; third-party packages resolve to `https://esm.sh/{package}`. Missing imports get placeholder empty components. CSS imports are injected as inline `<style>` tags.

Multiple import variants are registered per file (with/without extensions, with/without leading slash, `@/` alias form) to handle how Claude writes imports.

Syntax errors in individual files are skipped gracefully; other files continue processing.

### Database

SQLite via Prisma. Two models:
- `User` — email/password auth
- `Project` — stores chat history (`messages: String JSON`) and file system state (`data: String JSON`). `userId` is optional to support anonymous users.

Generated client outputs to `src/generated/prisma/`.

### Authentication

JWT-based with `jose`. Sessions stored as httpOnly cookies (7-day expiry). Server actions in `src/actions/index.ts` (`signUp`, `signIn`, `signOut`, `getUser`). Anonymous users can create projects; work is preserved via `src/lib/anon-work-tracker.ts` (sessionStorage).

### Path Aliases

`@/*` resolves to `src/*` (configured in `tsconfig.json` and `vitest.config.mts`).

## Key File Locations

| Concern | Path |
|---------|------|
| AI chat API | `src/app/api/chat/route.ts` |
| System prompt | `src/lib/prompts/generation.tsx` |
| Virtual file system | `src/lib/file-system.ts` |
| AI tools | `src/lib/tools/` |
| Chat state | `src/lib/contexts/chat-context.tsx` |
| File system state | `src/lib/contexts/file-system-context.tsx` |
| Auth logic | `src/lib/auth.ts`, `src/actions/index.ts` |
| AI provider | `src/lib/provider.ts` |
| Prisma schema | `prisma/schema.prisma` |
| JSX transformer | `src/lib/transform/jsx-transformer.ts` |
| Preview iframe | `src/components/preview/PreviewFrame.tsx` |

## Environment Variables

- `ANTHROPIC_API_KEY` — required for real AI responses (falls back to mock if absent)
- `JWT_SECRET` — defaults to `"development-secret-key"` if not set
