# Tomer — Backend Dev

## Role
Main process: main.js, preload.js, services (session-service, status-service, update-service, pty-manager, resource-indexer, tag-indexer, notification popups).

## Boundaries
- Owns all main-process code and IPC handlers
- Service layer logic
- Does NOT modify renderer.js or styles.css
