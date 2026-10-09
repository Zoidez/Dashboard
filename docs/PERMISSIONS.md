# Dashboard — Permission display rules (v0)

How the approval canvas shows a card's permissions, when it marks danger, and what the approve button does. Applies to every new card and every update. Source of permission types: `spec/manifest.schema.json`. Status: user decisions 2026-10-09 (red marking, the confirmation dialog and its three buttons); the rest is Claude's design, open to change.

## 1. One line per permission, in plain words
Every permission is one line: what the card may do, in words, then the card's own one-line reason (from the manifest), shown as "Card says: ...". The user reads what the host will allow, never only the card's claim.

| Type | Line shown |
|---|---|
| `fs.read` | Read files in `<path>` (+ "and all its subfolders" if recursive) |
| `fs.write` | Create and change files in `<path>` (+ subfolders) |
| `fs.delete` | Delete files in `<path>` (+ subfolders). Deleted files go to the Recycle Bin. |
| `net.http`, only GET/HEAD | Fetch data from `<origin>` (paths starting `<prefix>`) |
| `net.http`, any POST/PUT/PATCH/DELETE | **Send data to** and fetch data from `<origin>` (paths starting `<prefix>`) |
| `sysinfo` | Read your computer's `<fields in words>`. `processes` reads "the names of running programs"; `network` reads "network adapter names and traffic". |
| `reports.read` | Read the reports of your scheduled task "<task name>" |
| `links.open` with `origins` | Open links to `<origins>` in your browser |
| `links.open` with `any: true` | Open **any** web link in your browser (yellow, section 3a) |

Paths are shown in full, never shortened. Instance-relative paths (`./...`) are shown resolved to the real folder.

## 2. Each permission can be switched off
Every line has a checkbox, on by default. Unchecked permissions are not granted; the card is denied at runtime when it tries them and shows its own error state. Danger marking (section 4) is recomputed live as boxes change.

## 3. Single permissions that are marked on their own
Shown with a red marker and the explanation under the line:
- `fs.write` or `fs.delete` on a drive root, on the user folder or one of its top-level folders, or recursive on any of them: "can change or delete a large part of your files".
- Any `fs.*` scope on a folder where Windows starts programs automatically (Startup folders): "can make programs start with Windows".
- `net.http` to `http://localhost` or `http://127.0.0.1`: "can talk to programs running on this computer".
- `net.http` to an IP address in a loopback, private, link-local or otherwise non-public range (e.g. `https://192.168.1.10`, `https://169.254.169.254`): "can talk to devices on your local network or to this computer" (user decision 2026-10-09). The broker allows such an address only when the permission names it.

## 3a. Caution marking (yellow)
Yellow means "worth a look", not "dangerous". It is shown with a yellow marker, a text tag (Y) and the explanation under the line, but it does **not** trigger the approval dialog (section 6); red always wins over yellow.
- `links.open` with `any: true`: "can open any web link in your browser. A link's address can carry what the card reads." (user decision 2026-10-09: opening links to listed, known sites is fine; opening arbitrary links is yellow.)

The validator already rejects scopes inside the Dashboard's own folder (RULES.md, host invariant 12), so they never reach the canvas.

## 4. Dangerous combinations
A combination is dangerous when two permissions together allow something neither allows alone. Each one gets a letter and a sentence that names the real paths and origins.

| ID | Combination | Sentence shown |
|---|---|---|
| D1 | anything that reads (`fs.read`, `reports.read`, `sysinfo`) + any `net.http` | "Can read `<what>` and send it to `<origins>`." (Also for GET-only: a request's address can carry data.) |
| D2 | any `net.http` + `fs.write` | "Can download data from `<origins>` and save it into `<path>`." |
| D3 | `fs.read` + `fs.write` or `fs.delete` on overlapping folders, where one scope is marked under section 3 | "Can read and rewrite or delete `<path>`." |

## 5. How danger is shown (red)
- Every line that takes part in a dangerous combination or a single-permission marking is shown in red and tagged with its combination letters (D1, D2...).
- The card frame on the canvas is red as long as any red line is still checked, and a red banner above the list repeats the sentences from section 4.
- When the user unchecks lines until a combination no longer holds, its red marking disappears at once.
- Red is never the only signal: every red line also carries the text tag and the sentence (accessibility, and colour-blind users).

## 6. The approve button
If no red marking remains, the card is approved as shown.
If any red marking remains when the user presses Approve, a dialog opens:

> Do you want to **allow** this permission combination?
> (the red sentences, listed)
>
> [No]  [Yes, always]  [Yes, only now]

- **No** (default; Enter and Esc choose it): back to the canvas. Nothing is approved.
- **Yes, only now**: approves this version of the card. The next update of this card shows the dialog again, even if the combination is unchanged.
- **Yes, always**: approves this version and remembers the allowance for **this card ID and these exact permission scopes**. Later updates of this card that keep the same red combination skip the dialog; the lines are still shown in red on the canvas. If any scope in the combination changes (path, origin, method, field), the dialog returns.
- An allowance never applies to another card. Allowances are listed per card in File > Options > Cards and can be revoked there; revoking one makes the next update ask again.
- "Yes, always" never skips the canvas itself: every new version of the card still needs the user's approval (RULES.md, host invariant 5).

## 7. Updates
For an update the canvas also shows the permission diff: added lines marked "new", removed lines struck through, changed scopes with old and new values. A new or widened permission is never covered by an earlier "Yes, always".

## Open
- Startup-folder and "large part of your files" detection needs an exact list of folders (Known Folder IDs), to be written with the validator.
- Whether `sysinfo processes` alone deserves a marker.
