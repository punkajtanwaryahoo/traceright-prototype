# Deploying the TraceRight backend (one time, about 5 minutes)

1. Open the Google Sheet **PPSPL Database on Sheets** in a desktop browser.
2. Menu **Extensions → Apps Script**. A new tab opens with a file called `Code.gs`.
3. Delete everything in `Code.gs`, then paste the full contents of `backend/Code.gs` from this repository. Click the **Save** icon.
4. In the toolbar function list choose **setup**, then click **Run**.
   - Google asks for authorisation: **Review permissions → choose your account → Advanced → Go to (project) → Allow**.
   - The log at the bottom should say: `All tabs found. Backend ready, version 0.1.0`.
5. Click **Deploy → New deployment**.
   - Gear icon next to "Select type" → **Web app**.
   - Description: `TraceRight 0.1`
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, then **Authorise access** if asked again.
6. Copy the **Web app URL** (it ends in `/exec`) and send it to Claude. It goes into `config.js`.

## Updating the backend later

Version 0.3.0 (28-Nov-2026) needs the sheet changes already made: WHS_Master FTY_Code + WIP01, USR004 manager,
BUN_Event From_Where/To_Where/Auth_By/Auth_Ref, the AUTH_Requests tab and CONFIG Next_AUTH_ID / Auth_Expiry_Hours.
After updating, everyone must log in again (the login now includes the location).


Paste the new `Code.gs`, Save, then **Deploy → Manage deployments → pencil (Edit) → Version: New version → Deploy**.
The web app URL stays the same.

## Why "Anyone"

The phones are not logged in to Google, so the web app must accept calls from anyone. Every call except
`masters` and `login` needs a valid login token (USR_Code + PIN + location, signed by the backend and valid for 12 hours).
An approver's PIN entered on someone else's phone is checked once and never stored; 5 wrong PINs lock that user for 15 minutes.
PINs are never sent to the phone.
