

<skills_system priority="1">

## Available Skills

<!-- SKILLS_TABLE_START -->
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:
- Invoke: `npx openskills read <skill-name>` (run in your shell)
  - For multiple: `npx openskills read skill-one,skill-two`
- The skill content will load with detailed instructions on how to complete the task
- Base directory provided in output for resolving bundled resources (references/, scripts/, assets/)

Usage notes:
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already loaded in your context
- Each skill invocation is stateless
</usage>

<available_skills>

<skill>
<name>algorithmic-art</name>
<description>Creating algorithmic art using p5.js with seeded randomness and interactive parameter exploration. Use this when users request creating art using code, generative art, algorithmic art, flow fields, or particle systems. Create original algorithmic art rather than copying existing artists' work to avoid copyright violations.</description>
<location>project</location>
</skill>

<skill>
<name>brand-guidelines</name>
<description>Applies Anthropic's official brand colors and typography to any sort of artifact that may benefit from having Anthropic's look-and-feel. Use it when brand colors or style guidelines, visual formatting, or company design standards apply.</description>
<location>project</location>
</skill>

<skill>
<name>canvas-design</name>
<description>Create beautiful visual art in .png and .pdf documents using design philosophy. You should use this skill when the user asks to create a poster, piece of art, design, or other static piece. Create original visual designs, never copying existing artists' work to avoid copyright violations.</description>
<location>project</location>
</skill>

<skill>
<name>doc-coauthoring</name>
<description>Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users efficiently transfer context, refine content through iteration, and verify the doc works for readers. Trigger when user mentions writing docs, creating proposals, drafting specs, or similar documentation tasks.</description>
<location>project</location>
</skill>

<skill>
<name>docx</name>
<description>"Comprehensive document creation, editing, and analysis with support for tracked changes, comments, formatting preservation, and text extraction. When Claude needs to work with professional documents (.docx files) for: (1) Creating new documents, (2) Modifying or editing content, (3) Working with tracked changes, (4) Adding comments, or any other document tasks"</description>
<location>project</location>
</skill>

<skill>
<name>frontend-design</name>
<description>Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, artifacts, posters, or applications (examples include websites, landing pages, dashboards, React components, HTML/CSS layouts, or when styling/beautifying any web UI). Generates creative, polished code and UI design that avoids generic AI aesthetics.</description>
<location>project</location>
</skill>

<skill>
<name>internal-comms</name>
<description>A set of resources to help me write all kinds of internal communications, using the formats that my company likes to use. Claude should use this skill whenever asked to write some sort of internal communications (status reports, leadership updates, 3P updates, company newsletters, FAQs, incident reports, project updates, etc.).</description>
<location>project</location>
</skill>

<skill>
<name>mcp-builder</name>
<description>Guide for creating high-quality MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools. Use when building MCP servers to integrate external APIs or services, whether in Python (FastMCP) or Node/TypeScript (MCP SDK).</description>
<location>project</location>
</skill>

<skill>
<name>pdf</name>
<description>Comprehensive PDF manipulation toolkit for extracting text and tables, creating new PDFs, merging/splitting documents, and handling forms. When Claude needs to fill in a PDF form or programmatically process, generate, or analyze PDF documents at scale.</description>
<location>project</location>
</skill>

<skill>
<name>pptx</name>
<description>"Presentation creation, editing, and analysis. When Claude needs to work with presentations (.pptx files) for: (1) Creating new presentations, (2) Modifying or editing content, (3) Working with layouts, (4) Adding comments or speaker notes, or any other presentation tasks"</description>
<location>project</location>
</skill>

<skill>
<name>skill-creator</name>
<description>Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Claude's capabilities with specialized knowledge, workflows, or tool integrations.</description>
<location>project</location>
</skill>

<skill>
<name>ai-app-development</name>
<description>Comprehensive guide for building AI applications including RAG (Retrieval-Augmented Generation), skill development, function calling, LangChain integration, and other modern AI development patterns. Use when building AI-powered applications, implementing RAG systems, creating custom skills/tools, integrating function calling capabilities, working with LangChain or similar frameworks, or developing agent-based systems.</description>
<location>project</location>
</skill>

<skill>
<name>slack-gif-creator</name>
<description>Knowledge and utilities for creating animated GIFs optimized for Slack. Provides constraints, validation tools, and animation concepts. Use when users request animated GIFs for Slack like "make me a GIF of X doing Y for Slack."</description>
<location>project</location>
</skill>

<skill>
<name>template</name>
<description>Replace with description of the skill and when Claude should use it.</description>
<location>project</location>
</skill>

<skill>
<name>theme-factory</name>
<description>Toolkit for styling artifacts with a theme. These artifacts can be slides, docs, reportings, HTML landing pages, etc. There are 10 pre-set themes with colors/fonts that you can apply to any artifact that has been creating, or can generate a new theme on-the-fly.</description>
<location>project</location>
</skill>

<skill>
<name>web-artifacts-builder</name>
<description>Suite of tools for creating elaborate, multi-component claude.ai HTML artifacts using modern frontend web technologies (React, Tailwind CSS, shadcn/ui). Use for complex artifacts requiring state management, routing, or shadcn/ui components - not for simple single-file HTML/JSX artifacts.</description>
<location>project</location>
</skill>

<skill>
<name>webapp-testing</name>
<description>Toolkit for interacting with and testing local web applications using Playwright. Supports verifying frontend functionality, debugging UI behavior, capturing browser screenshots, and viewing browser logs.</description>
<location>project</location>
</skill>

<skill>
<name>xlsx</name>
<description>"Comprehensive spreadsheet creation, editing, and analysis with support for formulas, formatting, data analysis, and visualization. When Claude needs to work with spreadsheets (.xlsx, .xlsm, .csv, .tsv, etc) for: (1) Creating new spreadsheets with formulas and formatting, (2) Reading or analyzing data, (3) Modify existing spreadsheets while preserving formulas, (4) Data analysis and visualization in spreadsheets, or (5) Recalculating formulas"</description>
<location>project</location>
</skill>

</available_skills>
<!-- SKILLS_TABLE_END -->

</skills_system>



# CLAUDE.md

This file provides guidance to AI coding assistants (e.g., Claude Code, GitHub Copilot, Cursor) when working with this repository.

## Project Overview

AIHR is an open-source AI web automation Chrome extension that runs multi-agent systems locally in the browser. It's a free alternative to OpenAI Operator with support for multiple LLM providers (OpenAI, Anthropic, Gemini, Ollama, etc.).

## Development Commands

**Package Manager**: Always use `pnpm` (required, configured in Cursor rules)

**Core Commands**:

- `pnpm install` - Install dependencies
- `pnpm dev` - Start development mode with hot reload
- `pnpm build` - Build production version
- `pnpm type-check` - Run TypeScript type checking
- `pnpm lint` - Run ESLint with auto-fix
- `pnpm prettier` - Format code with Prettier

**Testing**:

- `pnpm e2e` - Run end-to-end tests (builds and zips first)
- `pnpm zip` - Create extension zip for distribution
- `pnpm -F chrome-extension test` - Run unit tests (Vitest) for core extension
  - Targeted example: `pnpm -F chrome-extension test -- -t "Sanitizer"`

### Workspace Tips

- Scope tasks to a single workspace to speed up runs:
  - `pnpm -F chrome-extension build`
  - `pnpm -F packages/ui lint`
- Prefer workspace-scoped commands over root-wide runs when possible.

Targeted examples (fast path):
- `pnpm -F pages/side-panel build` — build only the side panel
- `pnpm -F chrome-extension dev` — dev-watch background/service worker
- `pnpm -F packages/storage type-check` — TS checks for storage package
- `pnpm -F pages/side-panel lint -- src/components/ChatInput.tsx` — lint a file
- `pnpm -F chrome-extension prettier -- src/background/index.ts` — format a file

**Cleaning**:

- `pnpm clean` - Clean all build artifacts and node_modules
- `pnpm clean:bundle` - Clean just build outputs
- `pnpm clean:turbo` - Clear Turbo state/cache
- `pnpm clean:node_modules` - Remove dependencies in current workspace
- `pnpm clean:install` - Clean node_modules and reinstall dependencies
- `pnpm update-version` - Update version across all packages

## Architecture

This is a **monorepo** using **Turbo** for build orchestration and **pnpm workspaces**.

### Workspace Structure

**Core Extension**:

- `chrome-extension/` - Main Chrome extension manifest and background scripts
  - `src/background/` - Background service worker with multi-agent system
  - `src/background/agent/` - AI agent implementations (Navigator, Planner, Validator)
  - `src/background/browser/` - Browser automation and DOM manipulation

**UI Pages** (`pages/`):

- `side-panel/` - Main chat interface (React + TypeScript + Tailwind)
- `options/` - Extension settings page (React + TypeScript)
- `content/` - Content script for page injection

**Shared Packages** (`packages/`):

- `shared/` - Common utilities and types
- `storage/` - Chrome extension storage abstraction
- `ui/` - Shared React components
- `schema-utils/` - Validation schemas
- `i18n/` - Internationalization
- Others: `dev-utils/`, `zipper/`, `vite-config/`, `tailwind-config/`, `hmr/`,
  `tsconfig/`

### Multi-Agent System

The core AI system consists of three specialized agents:

- **Navigator** - Handles DOM interactions and web navigation
- **Planner** - High-level task planning and strategy
- **Validator** - Validates task completion and results

Agent logic is under `chrome-extension/src/background/agent/`.

### Build System

- **Turbo** manages task dependencies and caching
- **Vite** bundles each workspace independently
- **TypeScript** with strict configuration across all packages
- **ESLint** + **Prettier** for code quality
- Each workspace has its own `vite.config.mts` and `tsconfig.json`

### Key Technologies

- **Chrome Extension Manifest V3**
- **React 18** with TypeScript
- **Tailwind CSS** for styling
- **Vite** for bundling
- **Puppeteer** for browser automation
- **Chrome APIs** for browser automation
- **LangChain.js** for LLM integration

## Development Notes

- Extension loads as unpacked from `dist/` directory after build
- Hot reload works in development mode via Vite HMR
- Background scripts run as service workers (Manifest V3)
- Content scripts inject into web pages for DOM access
- Multi-agent coordination happens through Chrome messaging APIs
- Distribution zips are written to `dist-zip/`
- Build flags: set `__DEV__=true` for watch builds; 
- Do not edit generated outputs: `dist/**`, `build/**`, `packages/i18n/lib/**`

## Unit Tests

- Framework: Vitest
- Location/naming: `chrome-extension/src/**/__tests__` with `*.test.ts`
- Run: `pnpm -F chrome-extension test`
- Targeted example: `pnpm -F chrome-extension test -- -t "Sanitizer"`
- Prefer fast, deterministic tests; mock network/browser APIs

## Testing Extension

After building, load the extension:

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist/` directory

## Internationalization (i18n)

### Key Naming Convention

Follow the structured naming pattern: `component_category_specificAction_state`

**Semantic Prefixes by Component:**

- `bg_` - Background service worker operations
- `exec_` - Executor/agent execution lifecycle
- `act_` - Agent actions and web automation
- `errors_` - Global error messages
- `options_` - Settings page components
- `chat_` - Chat interface elements
- `nav_` - Navigation elements
- `permissions_` - Permission-related messages

**State-Based Suffixes:**

- `_start` - Action beginning (e.g., `act_goToUrl_start`)
- `_ok` - Successful completion (e.g., `act_goToUrl_ok`)
- `_fail` - Failure state (e.g., `exec_task_fail`)
- `_cancel` - Cancelled operation
- `_pause` - Paused state

**Error Categorization:**

- `_errors_` subcategory for component-specific errors
- Global `errors_` prefix for system-wide errors
- Descriptive error names (e.g., `act_errors_elementNotExist`)

**Command Structure:**

- `_cmd_` for command-related messages (e.g., `bg_cmd_newTask_noTask`)
- `_setup_` for configuration issues (e.g., `bg_setup_noApiKeys`)

### Usage

```typescript
import { t } from '@extension/i18n';

// Simple message
t('bg_errors_noTabId')

// With placeholders
t('act_click_ok', ['5', 'Submit Button'])
```

### Placeholders

Use Chrome i18n placeholder format with proper definitions:

```json
{
  "act_goToUrl_start": {
    "message": "Navigating to $URL$",
    "placeholders": {
      "url": {
        "content": "$1",
        "example": "https://example.com"
      }
    }
  }
}
```

**Guidelines:**

- Use descriptive, self-documenting key names
- Separate user-facing strings from internal/log strings
- Follow hierarchical naming for maintainability
- Add placeholders with examples for dynamic content
- Group related keys by component prefix

### Generation

- Do not edit generated files under `packages/i18n/lib/**`.
- The generator `packages/i18n/genenrate-i18n.mjs` runs via the `@extension/i18n`
  workspace `ready`/`build` scripts to (re)generate types and runtime helpers.
  Edit source locale JSON in `packages/i18n/locales/**` instead.

## Code Quality Standards

### Development Principles

- **Simple but Complete Solutions**: Write straightforward, well-documented code that fully addresses requirements
- **Modular Design**: Structure code into focused, single-responsibility modules and functions
- **Testability**: Design components to be easily testable with clear inputs/outputs and minimal dependencies
- **Type Safety**: Leverage TypeScript's type system for better code reliability and maintainability

### Code Organization

- Extract reusable logic into utility functions or shared packages
- Use dependency injection for better testability
- Keep functions small and focused on a single task
- Prefer composition over inheritance
- Write self-documenting code with clear naming

### Style & Naming

- Formatting via Prettier (2 spaces, semicolons, single quotes,
  trailing commas, `printWidth: 120`)
- ESLint rules include React/Hooks/Import/A11y + TypeScript
- Components: `PascalCase`; variables/functions: `camelCase`;
  workspace/package directories: `kebab-case`
- Enforced rule: `@typescript-eslint/consistent-type-imports`
  (use `import type { ... } from '...'` for type-only imports)

### Quality Assurance

- Run `pnpm type-check` before committing to catch TypeScript errors
- Use `pnpm lint` to maintain code style consistency
- Write unit tests for business logic and utility functions
- Test UI components in isolation when possible

### Security Guidelines

- **Input Validation**: Always validate and sanitize user inputs, especially URLs, file paths, and form data
- **Credential Management**: Never log, commit, or expose API keys, tokens, or sensitive configuration
- **Content Security Policy**: Respect CSP restrictions and avoid `eval()` or dynamic code execution
- **Permission Principle**: Request minimal Chrome extension permissions required for functionality
- **Data Privacy**: Handle user data securely and avoid unnecessary data collection or storage
- **XSS Prevention**: Sanitize content before rendering, especially when injecting into web pages
- **URL Validation**: Validate and restrict navigation to prevent malicious redirects
- **Error Handling**: Avoid exposing sensitive information in error messages or logs
 - **Secrets/Config**: Use `.env.local` (git‑ignored) and prefix variables with `VITE_`.
   Example: `VITE_POSTHOG_API_KEY`. Vite in `chrome-extension/vite.config.mts` loads
   `VITE_*` from the parent directory.

## Important Reminders

- Always use `pnpm` package manager (required for this project)
- Node.js version: follow `.nvmrc` and `package.json` engines
- Use `nvm use` to match `.nvmrc` before installing
- `engine-strict=true` is enabled in `.npmrc`; non-matching engines fail install
- Turbo manages task dependencies and caching across workspaces
- Extension builds to `dist/` directory which is loaded as unpacked extension
- Zipped distributions are written to `dist-zip/`
- Only supports Chrome/Edge 
- Keep diffs minimal and scoped; avoid mass refactors or reformatting unrelated files
- Do not modify generated artifacts (`dist/**`, `build/**`, `packages/i18n/lib/**`)
  or workspace/global configs (`turbo.json`, `pnpm-workspace.yaml`, `tsconfig*`)
  without approval
 - Prefer workspace-scoped checks:
   `pnpm -F <workspace> type-check`, `pnpm -F <workspace> lint`,
   `pnpm -F <workspace> prettier -- <changed-file>`, and build if applicable
- Vite aliases: pages use `@src` for page `src/`; the extension uses
  `@root`, `@src`, `@assets` (see `chrome-extension/vite.config.mts`). Use
  `packages/vite-config`’s `withPageConfig` for page workspaces.
 - Only use scripts defined in `package.json`; do not invent new commands
 - Change policy: ask first for new deps, file renames/moves/deletes, or
   global/workspace config changes; allowed without asking: read/list files,
   workspace‑scoped lint/format/type-check/build, and small focused patches
 - Reuse existing building blocks: `packages/ui` components and
   `packages/tailwind-config` tokens instead of re-implementing
