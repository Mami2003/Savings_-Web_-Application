# Ours — shared savings tracker

A responsive savings dashboard for tracking deposits, categorized expenses, a savings goal and date, a monthly spending plan, and a checklist of smaller goals. It uses EUR and updates open browsers in real time.

The monthly expense total rolls over on the first of each month in Europe/Vienna time; individual expenses stay in the activity history and continue to count toward the reservoir. The checklist is cleared for fresh goals at the same monthly rollover. Rollover happens automatically while the app is running, on startup, and the next time it receives a request after being offline.

## Run locally

Requires Node.js 20 or newer. No third-party packages are required.

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000). The app saves shared data to `data/savings.json`; set `DATA_DIR` to choose a different writable data directory. Keep that directory on persistent storage when deploying.

## Share with someone

Deploy this Node.js app to a host that supports persistent storage, set its `PORT` as required by the host, then share the deployed URL using **Share this space**. Both people must use the same deployed URL to see the same data and live updates. The app is intentionally open to anyone with its URL: there is no sign-in or access control, so anyone who gets the link can see, add, or change its financial data. Use a private deployment/link if that is not appropriate.

The built-in Node server supports standard Node hosting, serves the dashboard and API from one origin, and streams changes to connected browsers with server-sent events. A host that sleeps when idle may briefly pause live updates; browsers reconnect automatically.

## Deploy online with Render

The included [`render.yaml`](./render.yaml) configures a Node web service and a 1 GB persistent disk at `/var/data`. Render requires a paid web service for a persistent disk; check [Render's current pricing](https://render.com/pricing) before creating it. The persistent disk is important: without one, expense and goal data can be lost when the service restarts or redeploys. This setup is intended to run as a single service instance.

1. In VS Code, open **Source Control**, stage the project files, create the first commit, and push it to your GitHub repository. This repository currently has no commits, so it needs an initial commit before Render can deploy it. The `.gitignore` file excludes the local `data/` folder; do not upload `data/savings.json` to GitHub.
2. Create or sign in to a Render account and connect your GitHub account.
3. In Render, choose **New → Blueprint**, select `Mami2003/Savings_-Web_-Application`, and apply the settings in `render.yaml`. The configured service uses the `starter` paid plan and a persistent disk.
4. Wait for the deployment to finish, then open the `onrender.com` URL shown on the service page. Share that URL with your girlfriend; both of you must use it to see the same saved data and live updates.

The online service starts with fresh data: Render cannot automatically see your computer's local `data/savings.json`. Keep your local data private and ask before transferring it; never commit it to GitHub. Anyone who gets the deployed link can view and change the finances because this app has no sign-in or access control.

## Verify

```sh
npm test
```
