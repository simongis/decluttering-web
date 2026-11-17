# Testing deleting on a real org (ADR 0016)

The automated tests cover the guard, the remover and the whole flow in the demo and the dev simulator, which never touch ArcGIS Online. Before a build with `VITE_DELETING=on` is published, run this once against a real org with **test layers only**.

## Set up

1. Register an OAuth app: Content › New item › Developer credentials › **OAuth 2.0 credentials (user authentication)**. Add the redirect URL `http://localhost:5173/` exactly (http, port 5173, trailing slash). No client secret is needed.
2. In `.env`: `VITE_ARCGIS_CLIENT_ID=<the client ID>` and `VITE_DELETING=on`.
3. `npm run dev`. It always uses port 5173; if it stops with "Port 5173 is in use", another dev server is running, so stop that one first.
4. Open `http://localhost:5173/` and check the header: `v<version> · <commit> · deleting on`.
5. In ArcGIS Online, create the test layers:
   - **A**: a small hosted feature layer (a published CSV is enough).
   - **B**: a hosted feature layer with a **hosted view** of it.
   - **C**: a hosted feature layer with **delete protection** on.
   - **D** (optional, admin only): a layer owned by another member.
   - **E** (optional): a web map that uses layer A.

## Checks

Sign in, run a scan and wait until maps and apps have been checked (the delete bar stops saying it is waiting).

| # | Do | Expect |
|---|----|--------|
| 1 | Look at the delete bar above the list | It says what it can do: ready, waiting, no privilege, or no layers on the list |
| 2 | Drag a rectangle over A on the chart | A gets a red ring; the line above the chart counts it |
| 3 | Click A's dot | A menu with **View item** and **Delete…**; nothing opens yet |
| 4 | **View item** | A's item page opens in a new tab |
| 5 | **Delete…** on A, type the word, confirm | "Deleted 1 layer"; A leaves the list and the chart |
| 6 | In ArcGIS Online, open the recycle bin | A is there and can be restored (**not yet verified; record what you see**) |
| 7 | With E: open E | E shows a broken layer (the dialog warned about it) |
| 8 | Delete B | The dialog lists B and its view; both are gone afterwards, the view first |
| 9 | Delete C | Reported as not deleted: delete protection is on. C is untouched |
| 10 | As an admin with *Delete items*, delete D | Deleted. As a member without it, D has no Delete and the menu says why |
| 11 | Select several layers, start the delete and press **Stop** | Deleting stops before the next layer; the result lists what went and what didn't |
| 12 | Reload the page | Deleted layers do not come back from the saved scan |
| 13 | Sign in with an account that has neither privilege | The delete bar says the account can't delete; no Delete buttons |

Record the results, especially check 6 (the recycle bin) and check 8 (a layer with views), in the pull request. ADR 0016 stays **Proposed** until they pass.

## If something fails

- Copy the message from the dialog's result, and any errors from the browser console (F12).
- Note the version line from the header.
- For sign-in errors, copy the full URL of the ArcGIS error page: it shows the `client_id` and `redirect_uri` that were sent.
