# Which evacuation road closes first

A planning aid that will compare evacuation routes and estimate which one stays open longer. This step is only the local site shell.

**Planning aid, not an evacuation order.**

## Run locally

From this folder:

```bash
npx -y firebase-tools@latest emulators:start --only hosting --project demo-road-closes
```

Open [http://127.0.0.1:5002](http://127.0.0.1:5002).

The Hosting emulator is pinned to port 5002 because macOS AirPlay Receiver often listens on 5000. The demo project id lets the emulator run without a Firebase account.
