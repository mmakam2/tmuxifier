# Privacy Policy — tmuxifier console (Android app)

_Last updated: 2026-08-16_

Tmuxifier is self-hosted software. The Android app ("tmuxifier console", package
`com.tmuxifier.console`) is a client for a Tmuxifier server that **you** run, on hardware you
control. The developer of this app operates no service, no backend, and no analytics
infrastructure, and therefore **collects no data from you whatsoever**.

## What the app stores on your device

- The URL of the Tmuxifier server you chose to connect to.
- A device token issued by that server during pairing, held in encrypted storage backed by the
  Android Keystore. The token authenticates this device to your own server; it is not known to,
  or usable by, anyone else.
- Your notification preferences.

All of it is removed when you uninstall the app.

## What the app sends, and to whom

The app communicates with **one** destination: the Tmuxifier server address you enter. Nothing
is sent anywhere else, and the developer has no access to that traffic or that server.

Over that connection the app exchanges the data the product exists to show you: terminal pane
snapshots from your own machines, the keystrokes and text you choose to send to them, and the
status of the boxes on your fleet. Whether that connection is encrypted (HTTPS) is determined
by how you configure your own server.

## Push notifications (optional)

Push is off unless the operator of the server configures their own Firebase project. When it is
configured:

- The app obtains a Firebase Cloud Messaging (FCM) registration token from Google and sends it
  to **your** Tmuxifier server, which uses it to deliver notifications to this device.
- Notification content is limited to which of your machines produced an event and what kind of
  event it was.
- Message delivery is carried out by Google's FCM infrastructure and is subject to
  [Google's Privacy Policy](https://policies.google.com/privacy). The developer of this app
  receives nothing through that path — the sending credentials belong to whoever runs the
  server.

The app can be used without push; the notification permission is optional and may be declined
or revoked in Android settings.

## Permissions

- `INTERNET` — to reach the server you configured.
- `POST_NOTIFICATIONS` — to show notifications, if you enable them.

## No tracking

The app contains no analytics, no advertising, no crash-reporting, and no tracking SDKs. The
only third-party library that communicates off-device is Firebase Cloud Messaging, and only in
the optional case described above.

## Deleting your data

- Uninstalling the app removes everything it stored locally.
- To cut a device off from a server, revoke it in the server's Settings → Devices. Revocation
  takes effect on that device's next request.
- Any data on your Tmuxifier server is yours; the developer cannot access or delete it.

## Children

The app is a system administration tool intended for adults and is not directed at children.

## Changes

Material changes to this policy will be published in this file in the public repository, with
the date above updated.

## Contact

Questions about this policy: open an issue at
<https://github.com/mmakam2/tmuxifier/issues>.
