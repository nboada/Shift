# Google verification checklist

Shift requests `https://www.googleapis.com/auth/gmail.modify`, a **restricted** scope. Until the app is verified, everyone who signs in sees "Google hasn't verified this app", and the project can only ever have 100 users.

Shift calls Gmail directly from the user's Mac and stores mail only on that Mac. Google requires the paid annual security assessment (CASA) only for apps that access restricted data "from or through a server", so Shift needs **restricted-scope verification but not CASA**, as long as that stays true. Re-check before adding any feature that sends Gmail data off the device (a push-notification server, cloud AI).

Source: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification

## 1. Domain and pages (you)

- [ ] Pick the public home for Shift, e.g. `https://talkk.com.au/shift` (any domain you control).
- [ ] Verify that domain in Google Search Console with the same Google account that owns the `talkk-mail` Cloud project.
- [ ] Publish three pages on it:
  - Home page: what Shift is, with a link to the privacy policy.
  - Privacy policy: `docs/privacy-policy.md` (fill in the bracketed parts).
  - Terms of service: a short page is fine.

## 2. Google Auth Platform → Branding (talkk-mail project)

- [ ] App name: **Shift**
- [ ] User support email and developer contact email
- [ ] App logo: 120×120 PNG (`src-tauri/icons/128x128.png` scaled down)
- [ ] App home page, privacy policy and terms links from step 1
- [ ] Authorized domains: the verified domain

## 3. Google Auth Platform → Data access

- [ ] Scopes: only `.../auth/gmail.modify`. Remove anything else listed.
- [ ] Justification (paste):

> Shift is a desktop email client for Gmail. It needs gmail.modify to show the user's mailbox, send and reply to email, save drafts, and archive, label, mark read, star and move messages to Trash at the user's request. Narrower scopes don't cover this: gmail.readonly can't send or organize mail, and gmail.send/gmail.compose can't read it. Mail is fetched directly from the Gmail API to the user's own device and stored only there; it is never sent to our servers, shared, sold or used for advertising.

## 4. Demo video (unlisted YouTube)

Record the real app (not demo mode), signed in with a test Gmail account, in English, about 3–4 minutes:

1. Show the app's About/Settings with the name **Shift** and the OAuth client in use.
2. Click **Sign in with Google**. In the browser, show the consent screen with the **app name and the gmail.modify permission visible**, then approve.
3. Back in Shift: the inbox loads (reading mail).
4. Open an email (reading message bodies).
5. Reply and send (sending), then show it in Sent.
6. Start a new email, wait for "Saved" (drafts), then discard it.
7. Archive one email, label one, mark one unread, move one to Trash (modifying).
8. Settings → Accounts → **Log out** (shows the user can disconnect and local mail is removed).
9. Say once: "Email stays on this Mac; Shift has no servers."

## 5. Submit

- [ ] Audience: **In production**, then **Prepare for verification** and submit.
- [ ] Watch the project's contact email: Google often asks follow-up questions, and the review can take several weeks.
- [ ] After approval, Google asks you to re-verify about once a year.

## Until it's approved

- New users see the "unverified" warning and must click **Advanced → Go to Shift (unsafe)**.
- The 100-user lifetime cap counts every account that ever signs in, including test accounts. Use a small set of test accounts.
