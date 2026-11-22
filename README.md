# LEXINTEL — live legal & academic opportunity feed (Android + GitHub)

Architecture (all free tier):

    GitHub Actions (daily, 06:00 IST)
      -> pipeline/run.js: fetch sources -> Claude extracts structured entries -> validated against source text
      -> docs/feed.json  (committed)  -> GitHub Pages serves it
    Android app (Capacitor)  -> fetches feed.json on launch/refresh, caches offline, hides expired items

## One-time setup (about 15 minutes)

1. **Create a GitHub repo** (e.g. `lexintel`) and push this whole folder to it (`main` branch).
2. **Add your API key:** repo Settings > Secrets and variables > Actions > New secret `ANTHROPIC_API_KEY`.
3. **Enable Pages:** Settings > Pages > Source: "Deploy from a branch" > `main` / `/docs`.
4. **Run the first update:** Actions tab > "Update LEXINTEL feed" > Run workflow. Check the run log: it prints every source as `ok`/`ERR` with the reason.
   After it finishes, open `https://<username>.github.io/<repo>/feed.json` to confirm items exist.
5. **Point the app at it:** edit `app.config.json` -> `"feedUrl": "https://<username>.github.io/<repo>/feed.json"`.
6. **Build the APK** (needs Android Studio / JDK 21 / Android SDK 36 on your computer):

        npm install
        npm run sync
        npm run apk        # android/app/build/outputs/apk/debug/app-debug.apk

After this the feed refreshes itself every day with no action from you; the app picks up changes on next open/refresh.

## Human review (the "verified" badge is real now)
New items start as **Auto-extracted · unreviewed**. To review:

    npm run ingest                      # (or pull the latest feed.json)
    node pipeline/review.js list        # shows deadline, the quoted source text, links
    node pipeline/review.js approve <id> --by "Your Name"
    node pipeline/review.js reject  <id> --by "Your Name"
    git commit pipeline/reviews.json && git push

Approvals are git commits, so each has an identity and timestamp. Rejected items never reappear.

## What the pipeline guarantees (tested in tests/pipeline.test.js)
- A deadline is kept only if the model's quoted evidence appears verbatim in the page text AND the day/month/year match the evidence; otherwise the deadline is dropped and the item flagged "Verify details".
- `official_url` is kept only if it appears in the page's links/text (no invented URLs).
- Expired items are removed; unchanged pages are not re-processed (cost control); duplicates across sources are merged.
- One failing source never breaks the others; if ALL fail the old feed is kept. The app shows source health and warns if the feed is >3 days stale.
- Respects robots.txt, identifies itself, rate-limits per host.

## Limits you should know
- Coverage = the sources in `pipeline/sources.json` only. Add/remove sources there. The feed URLs were not verifiable from the build environment: check the first run's log. `html-links` sources (OHCHR) depend on page structure and JS-rendered pages will report an error.
- AI extraction can still be wrong in ways the checks can't catch (e.g. a real date attached to the wrong call). That is why review exists.
- Cost: first run extracts up to 60 pages (`MAX_EXTRACTIONS_PER_RUN`), later runs only new/changed pages.
- No push notifications yet; the app shows "Due soon" for items you track.
- Data you track (notes, stages) lives on the device only.

## Dev
    npm test            # builds web, runs pipeline + app tests
    npm run ingest      # run the pipeline locally (needs ANTHROPIC_API_KEY)
