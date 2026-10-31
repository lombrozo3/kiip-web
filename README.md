# Kiip for the web

A website for the library that the Kiip Android app syncs to Google Drive. It has no server: the page signs in with Google and reads the "Kiip Library" folder from the person's own Drive straight into the browser. It acts as one more device, writing only its own copy, `device-web.json`, which the app merges in like any other.

The address it runs from has to be listed as an authorized JavaScript origin on the Google OAuth client named in `app.js`. That client ID isn't a secret. No library data is stored in this repository.

- `data.js`: merging each device's copy of the library, making changes to it, and filtering and sorting. The merge follows `Changes.kt` in the app.
- `app.js`: sign-in, reading from and writing to Drive, and the page.

Run the tests with `node --test test/`.
