# 0016 Deleting layers from Review, off by default

**Status:** Proposed. Amends the "never deletes" guardrail in 0002, 0005 and 0012.

## Context
Review finds hosted feature layers that are stale or large. Until now the app stopped at an email, and the owner did the clean-up in ArcGIS Online. Admins and owners asked to delete from the app itself, with the account they signed in with.

The app had a hard rule: it never deletes owners' items. Deleting is also the most damaging thing the app could do. So this ADR adds it behind the same kind of controls as sending (0013), and keeps the rule for every build that does not turn it on.

## Decision
1. **Off unless the build says so.** `VITE_DELETING=on` is the one setting. Unset, empty or any other value means the app never offers or sends a delete (`src/auth/deleting.ts`). The Pages workflow passes it from the repository variable `VITE_DELETING`.
2. **Whose layers.** At sign-in the scope is worked out from privileges: `all` with `portal:admin:deleteItems` (delete content in the organization), `own` with `portal:user:createItem` (create, edit and delete your own content), otherwise `none`. This only decides what the app offers. ArcGIS Online still enforces its own rules.
3. **Its own allow-list** (`src/remove/guard.ts`), separate from the read-only scan guard and the notifier's guard, which stay unchanged. It permits two calls: reading one item, and `content/users/{owner}/[{folder}/]items/{id}/delete` (POST). The delete is blocked unless the signed-in user may delete that owner's items, and it carries no parameter beyond `f`, so `permanentDelete` can never be sent. The ArcGIS Online recycle bin, where the org has one, applies.
4. **What a delete means.** The chosen unit is a layer's family: its hosted views go first, then the source. A view breaks without its source, so they are listed in the dialog and deleted together.
5. **Check, then act.** Just before deleting a family, the remover reads every member. It leaves the whole family alone, and says why, if a member is protected, is no longer a hosted feature layer, or has a different owner than the scan saw. An item that is already gone counts as removed. A delete only counts if ArcGIS Online answers `success: true`.
6. **Only on a trustworthy scan.** The buttons switch on when maps and apps have been read, the scan was not stopped and no refresh is running (0007: "used by" is unreliable before that). The dialog shows how many maps and apps still use each layer.
7. **Confirmed every time.** A dialog lists every layer with owner, size, views and used-by, names the account doing the delete, and needs a typed word (`DELETE`, or `BORRAR` in Spanish). It cannot be closed while running; Stop ends it before the next family. The result lists what was deleted, the storage freed and each failure with its reason.
8. **Where it appears.** A Delete button in the item panel (any access level that has a scope), and "Delete ticked layers" in Review's action bar for admins, which deletes only the ticked layers the user may delete and says how many it left out.
9. **After a delete.** The layers leave the list on screen, the scan kept for Resume and the saved scan (`pruneCached`). Maps and apps that used a deleted layer are not checked again until the next scan, and the dialog says so.
10. **The demo** uses a stand-in remover (`src/demo/demo-remover.ts`) that answers yes and changes nothing, so the whole flow can be tried without an account.

## Consequences
- The hosted build keeps its promise (`VITE_DELETING` unset). A self-hosted or fork build can turn deleting on.
- A new write path means a new allow-list and tests (`src/remove/remove.test.ts`, `e2e/delete.spec.ts`). The scan guard test that no write can pass is unchanged.
- Not done here: restoring from the recycle bin, unprotecting items, deleting maps, apps or non-hosted items, and recording deletes in the app's log table.
- Copy elsewhere still says the app never deletes (About page, the admin note, the tour). It is true for any build with deleting off, so it is left as it is, and should be reworded before a build with deleting on is published.
- Both privilege names are in Esri's privileges reference. Unverified: the recycle bin behaviour, and a real delete of a hosted layer with views, need checking on a real org before this is accepted.
