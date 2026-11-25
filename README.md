# TraceRight prototype (PPSPL)

QR code traceability demo for CPVC pipes, fittings boxes and Agri pipes.

- App: https://punkajtanwaryahoo.github.io/traceright-prototype/
- Database: Google Sheet "PPSPL Database on Sheets", via the Apps Script backend in `backend/Code.gs`
- Deploying the backend: see `backend/DEPLOY.md`

| File | Purpose |
|---|---|
| `index.html`, `app.js` | App shell: login, package/pipe lookup, primary pack |
| `modules.js` | Transfer, Sales, Returns, Unpack, Repack, Dashboard (MOD003-MOD007) |
| `labels.html` | Print today's demo QR sheets (P1+B1, F1, A1) and repack labels (R1) on A4 |
| `camtest.html`, `samples.html` | Camera test and sample codes |
| `qrparse.js` | Decodes QR codes per the 16-Nov-2026 coding scheme |
| `api.js`, `scanner.js`, `config.js`, `styles.css` | Shared code and settings |
| `backend/Code.gs` | Google Apps Script backend |
