---
title: Easier reviews and a more reliable CLI
slug: review-and-cli
version: 1.2.0
date: 2026-10-06T16:30:00.000Z
featured: true
---
Reviews work better on phones, and comments on unlisted sites can be read without signing in. Posting comments still requires an account.

Send selected comments or all open comments to an agent as a feedback batch. The CLI can wait for sent feedback, so an agent responds when you explicitly queue a review.

`postplan versions <space/site> --json` now preserves file sizes, etags, authors, and all other server fields for scripts and agents. Failed uploads and forks also clean up delayed file writes reliably.

Update the CLI with `postplan upgrade` or `npm install -g @notsuhas/postplan@1.2.0`.
