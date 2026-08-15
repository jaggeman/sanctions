# Sanctions Intelligence Web App

This is a full-stack application for managing, searching, and importing global sanctions lists (UN, EU, US OFAC, PEP). It consists of a Firebase Cloud Functions backend, a Firestore database, and a Vite + React frontend.

## 🚀 Live Application
The production web app is deployed and accessible at:
**[https://sanctions-app-dev-01.web.app](https://sanctions-app-dev-01.web.app)**

## Prerequisites

- Node.js (v18 or newer recommended)
- Firebase CLI (`npm install -g firebase-tools`)
- Git

## Multi-Agent Workflow

This project follows a strict multi-agent and developer coordination workflow. Please read [GEMINI.md](./GEMINI.md) or [CLAUDE.md](./CLAUDE.md) for testing policies, coordination via claim files, PR conventions, and secure coding practices before contributing.

## Setup Instructions

### 1. Clone the repository

```bash
git clone https://github.com/jaggeman/sanctions.git
cd sanctions
```

### 2. Install Dependencies

Install backend dependencies:
```bash
npm install
```

Install frontend dependencies:
```bash
cd frontend
npm install
cd ..
```

### 3. Firebase Authentication

You need to be logged into your Firebase account that has access to the project:
```bash
firebase login
```

The active Firebase project is set to `sanctions-app-dev-01` in `.firebaserc`.

## Running Locally

To run the application locally, you'll want to start both the Firebase Emulators (for the backend/database) and the Vite development server (for the frontend).

### Start Firebase Emulators

In the root directory (`/sanctions`), run:
```bash
firebase emulators:start
```
This will start the local Firestore emulator and the Cloud Functions emulator (if you have deployed them locally).

### Start Frontend Dev Server

Open a new terminal window, navigate to the frontend directory, and start Vite:
```bash
cd frontend
npm run dev
```

The frontend will be available at `http://localhost:5173`. 
*(Note: To connect the frontend directly to the local emulator backend, ensure your API endpoints are pointing to the emulator's port, usually `http://localhost:5001/sanctions-app-dev-01/us-central1/api` instead of relative paths, or configure a proxy in `vite.config.ts`)*.

## CLI Tools & Importers

This project also includes command-line tools and scripts to fetch and parse large XML/CSV files directly into the database.

### Build the backend code
```bash
npm run build
```

### Bulk Importing (Large files)
For very large files (like the US OFAC or EU lists), it is recommended to place them in the local `data/` folder (which is ignored by Git).

Then, run the importer script locally to push the records to your database:
```bash
npm run import
```

### Run the CLI Tool
```bash
npm run cli -- --help
```

## Running Tests

The backend has three test layers (see [CLAUDE.md](./CLAUDE.md) §1 for the full policy): pure/offline unit tests, Firestore security rules tests, and integration tests against a real Firestore instance. The rules and integration layers require the **Firebase Firestore Emulator**, which in turn requires a **Java runtime (JDK 11+)** to be installed — the test scripts start and stop it automatically via `firebase emulators:exec`, so you don't need to run `firebase emulators:start` yourself first.

Install dependencies once (from the repo root):
```bash
npm install
```

Run everything (recommended before opening a PR — this is the merge gate, since there's no CI configured yet):
```bash
npm test
```

Run a single layer:
```bash
npm run test:unit         # fast, offline — parsers, normalization, API handlers with mocked Firestore
npm run test:rules        # firestore.rules against a real emulator
npm run test:integration  # uploadRecords etc. against a real emulator
```

Watch mode while iterating on the offline unit layer:
```bash
npm run test:watch
```

Test files live under `tests/unit`, `tests/rules`, and `tests/integration`, with shared XML/CSV fixtures in `tests/fixtures`. New code should follow the TDD policy in `CLAUDE.md` §1 — write the test first, watch it fail, then implement.

If another process on your machine already holds the Firestore emulator port, change `emulators.firestore.port` in `firebase.json` locally and leave the change uncommitted — the suite picks the port up from `FIRESTORE_EMULATOR_HOST`.

## Configuration

### `ADMIN_EMAILS` — required in production

A comma-separated allow-list of the email addresses permitted to reach the administrative endpoints (`/api/admin/*`, currently API token creation, listing and revocation).

```
ADMIN_EMAILS=alice@yourcompany.com,bob@yourcompany.com
```

The guard **fails closed**: if `ADMIN_EMAILS` is unset in production, nobody is an administrator and every admin endpoint returns 403. That is deliberate — the alternative failure mode is an open admin API — but it does mean **you must set this before deploying**, or token management will be unreachable.

Outside production (`NODE_ENV !== 'production'`), an unset list falls back to the dev test account `admin@sanctions.com` so local work isn't blocked. Setting `ADMIN_EMAILS` supersedes that fallback entirely.

Membership is re-read on every request, so removing someone from the list revokes their admin access immediately rather than when their session expires.

## 🚀 Hur man deployar (Laddar upp till produktion)

För att ladda upp dina ändringar så att de syns live på webben följer du dessa exakta steg. 

**Viktigt innan du börjar:**
Se till att ditt Firebase-projekt (`sanctions-app-dev-01`) är på **Blaze-planen (Pay-as-you-go)** i Firebase Console. Utan detta kan Google inte ladda upp din backend-kod (Cloud Functions).

### Steg 1: Bygg backend (API & Databas)
Först måste vi kompilera TypeScript-koden för vår backend.
```bash
# Ställ dig i huvudmappen (roten av projektet)
npm run build
```

### Steg 2: Bygg frontend (Webbappen)
Sedan måste vi paketera vår React/Vite-app så att den är redo för webben.
```bash
# Gå in i frontend-mappen
cd frontend

# Kör byggskriptet
npm run build

# Gå tillbaka till huvudmappen när det är klart
cd ..
```

### Steg 3: Skicka upp allting till Firebase
Nu när all kod är bygd laddar vi upp databasreglerna, backend-API:et och frontend-filerna på en och samma gång med Firebase CLI.
```bash
# Ladda upp till projektet
firebase deploy --project sanctions-app-dev-01
```

När terminalen är färdig (tar vanligtvis 1-2 minuter) kommer den spotta ut din Hosting URL. Appen är nu live! 🎉
