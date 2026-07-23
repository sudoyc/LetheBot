# Credential-Free Vitest Environment

This directory intentionally contains no `.env*` files. Vitest points Vite's
environment-file lookup here so the default test suite cannot implicitly read
credentials from the project root.
