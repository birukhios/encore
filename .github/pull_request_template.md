## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## How it was verified

- [ ] `npm test` (PostgreSQL — starts a throwaway database, or uses `DATABASE_URL`)
- [ ] `npm run build`
- [ ] Checked in a browser at phone and desktop widths (screenshots for UI changes)
- [ ] `ENCORE_ENV=production python3 server.py --check` (for release branches)

## AI assistance

- [ ] This PR includes AI-generated code
- [ ] The AI-generated code has been read and understood by the author
- [ ] Tests cover the AI-generated sections

## Risk

- [ ] Touches authentication, payments, permissions, SQL or uploads → needs a second reviewer
- [ ] Changes the database schema or workspace document shape (migration + `upgrade()` included)
- [ ] No secrets, customer data or demo data added to the repository
