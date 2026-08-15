# Sanctions Intelligence Web App

This is a full-stack application for managing, searching, and importing global sanctions lists (UN, EU, US OFAC, PEP). It consists of a Firebase Cloud Functions backend, a Firestore database, and a Vite + React frontend.

## 🚀 Live Application
The production web app is deployed and accessible at:
**[https://sanctions-app-dev-01.web.app](https://sanctions-app-dev-01.web.app)**

## Prerequisites

- Node.js (v18 or newer recommended)
- Firebase CLI (`npm install -g firebase-tools`)
- Git

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
