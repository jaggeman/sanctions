---
name: sanctions-repo-guide
description: Comprehensive workflow guide and runbook for developing, testing, maintaining documentation, importing lists, and contributing to the Sanctions Intelligence Web App codebase.
---

# Sanctions Repo Workflow & Development Guide

This skill provides step-by-step procedures, architectural overviews, testing policies, and documentation guidelines for the Sanctions Intelligence Web App (`sanctions`) codebase.

---

## 1. Project Structure Overview

- **`src/`** - Backend source code (TypeScript, Firebase Cloud Functions / Express API):
  - **`src/api/`** - REST API endpoints, routing, middleware, and OpenAPI documentation (`openapi.json`).
  - **`src/importer/`** - Parsers and fetchers for sanctions lists (UN, EU, US OFAC SDN, UK HMT, PEP, etc.).
  - **`src/search/`** - Screening engine, candidate search, token index, phonetic matching, and scoring algorithms.
  - **`src/mcp/`** - Model Context Protocol (MCP) server implementation for agent/tool integrations.
  - **`src/cli/`** - Command-line tools for batch jobs, calibration, and local data operations.
- **`frontend/`** - Frontend application built with React, Vite, TypeScript, and Material UI:
  - Search UI, sanction entity details, screening history, match review, and batch upload tools.
- **`tests/`** - Test suite organized into three distinct layers:
  - **`tests/unit/`** - Fast, pure logic tests (no live emulators required).
  - **`tests/rules/`** - Firestore Security Rules tests (requires Firestore emulator).
  - **`tests/integration/`** - End-to-end and database interaction tests (requires Firestore emulator).
- **`scripts/`** - Maintenance, benchmarking, and calibration scripts.
- **`.agents/`** - Agent skills and active claim board (`.agents/active/`) for multi-session coordination.

---

## 2. Development Runbook & Commands

### Backend Commands (Root Directory)
```bash
# Build TypeScript and copy OpenAPI specs
npm run build

# Run unit tests locally
npm run test:unit

# Run full test suite with Firestore emulator (requires JDK 11+)
npm test

# Run API locally in watch mode
npm run dev:api

# Run CLI commands
npm run cli -- --help

# Run data importer
npm run import
```

### Frontend Commands (`frontend/` Directory)
```bash
cd frontend

# Start local Vite development server (http://localhost:5173)
npm run dev

# Build frontend production bundle
npm run build

# Run frontend tests and linter
npm test
npm run lint
```

---

## 3. Testing Policy & TDD Workflow

Follow strict **Test-Driven Development (TDD)** on every feature or bugfix:

1. **Write failing test first (Red):**
   - For bug fixes, add a test reproducing the exact failure before modifying production code.
   - For new features, specify inputs, outputs, error handling, and authorization boundaries.
2. **Implement minimum code to pass (Green):**
   - Run `npm run test:unit` (or specific test file) to verify.
3. **Refactor & Keep Green:**
   - Run full suite before opening PRs or merging.
4. **Fixtures from real data:**
   - Never invent fixtures out of hand; extract verbatim sample records from actual source files (e.g. OFAC/EU XML exports) and keep them small in `tests/fixtures/`.

---

## 4. Working with Documentation (README & Rules)

When adding features, changing endpoints, or modifying behavior:

- **Update `README.md`:**
  - Keep installation, local run commands, and environment variables synchronized.
  - Document any new CLI tools, data import flags, or configuration options.
- **Update `src/api/openapi.json`:**
  - Whenever modifying backend routes, request parameters, or response shapes, update the OpenAPI specification file.
- **Update Rules & Coordination Files (`GEMINI.md` / `CLAUDE.md`):**
  - Adhere to the claim-board workflow: before editing shared hot-spots, create an active claim file in `.agents/active/<task-name>.md`.
  - Remove your claim file after merging changes.

---

## 5. Sanctions Data Ingestion & Importers

- Upstream lists (OFAC, EU, UN, etc.) can be multi-megabyte XML/CSV files.
- Place full-size data files in `data/` or `downloads/` (these are git-ignored to keep the repository lightweight).
- Always use streaming parsers (`sax`, `fast-xml-parser` streaming mode) to avoid out-of-memory errors on large lists.
- Turn off automatic type coercion for identifier fields (passports, national IDs, SDN IDs) to prevent leading zeros from being stripped.

---

## 6. Safe Deployment Guidelines

- Production project target is strictly locked to `sanctions-app-dev-01`.
- Deploy commands:
  ```bash
  # Deploy hosting (frontend)
  npm run deploy:hosting

  # Deploy backend Cloud Functions
  npm run deploy:functions

  # Deploy Firestore security rules and indexes
  npm run deploy:firestore
  ```
