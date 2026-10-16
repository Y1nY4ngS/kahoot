# QuizParty – self-hosted Kahoot-style quiz

Live quiz for 200+ players: multiple choice (faster = more points) and "guess the number" (closer = more points), max 1000 points per question.

## Run it

```bash
npm install
ADMIN_PASSWORD=choose-something npm start
```

| Page | Who | URL |
|---|---|---|
| Admin | you | `/admin` – create quizzes, start a game |
| Host screen | main projector / monitor | opens from admin ("Save & start game") |
| Group screen | 2nd monitor | `/groups?pin=123456` – button "Open group screen" in the host lobby |
| Player | phones | `/play` – via QR code or PIN |

## Groups

Players pick their group when joining: **KDO Zug, Zug 1, Zug 2, Zug 3, Zug 4** (list at the top of `server.js`, `GROUPS`). Their group is shown on their phone as a big colored banner (a different color per group) so it can be read from a distance.

- **Group screen** (`/groups?pin=…`): live counter of how many players joined each group. Open it in a second browser window and drag it to the second monitor. It keeps updating during the game for late joiners.
- **Wrong group?** In the lobby a player can tap **Wrong group? Change it** and pick another group. Not possible once the host has started the game.
- **Leaving the quiz:** while questions are running, a player who switches app, locks the phone or loses connection is counted as "left" for their group. This is shown **only on the group screen** (second monitor): a red notice "Zug 2: Zug 2 #7 left the quiz", a green one "… is back" when the player returns, a short log, and a line on the group's card like `2 left · 1 back · 1 away now`. The main host screen shows nothing about it. Both CSVs include it: the **Groups CSV** has `total_time_away_seconds` / `total_time_away_mm_ss` = the time of all players of the group added up (e.g. one player away 4 s, another 15 s, another 9 s → 28 s), the Players CSV has the time per player. Nothing in the lobby is counted. It is only shown, it does not change the points. A returning phone reconnects automatically and keeps its points.
- **No ranking during the game.** Between questions phones only show "Ready for the next question" (no points, no right/wrong), and the host screen only shows the answers.
- **Final ranking at the end:** group score = sum of all points of the group's players ÷ number of players in the group (average per player). Groups without players are left out. No individual players are ever shown (no top players, no closest guesser, no personal rank); only groups. Per-player points are only saved in the Players CSV for you.

Default admin password is `admin`. Change it with `ADMIN_PASSWORD`.

## Game day checklist

1. Deploy to a public host (Render, Fly.io, Railway or a small VPS) so phones can use mobile data instead of crowding the venue WiFi. Set `PUBLIC_URL=https://your-domain` so the QR code points to the right address.
2. In `/admin` create the quiz, click **Save & start game**, put the opened tab on the projector (F11 for fullscreen).
3. Click **Open group screen** in the host lobby and move that window to the second monitor.
4. Players scan the QR or open the site and enter the PIN and choose their group (no names; each player gets an automatic label like "Zug 2 #7").
5. Space / Enter on the host screen advances (start → skip → next).
6. At the end download **Groups CSV** (ranking by average) or **Players CSV**, or fetch past games from the admin sidebar.

If the host tab is reloaded mid-game it re-attaches to the running game. Players that lose connection rejoin automatically.

Note: on free hosting tiers that sleep when idle or restart the server, a running game is lost (live state is in memory). Use an always-on instance for the event.

## Scoring (`scoring.js`)

- **Multiple choice:** `1000 × (1 − 0.5 × timeTaken / timeLimit)`, wrong = 0. Instant = 1000, last second = 500. Time is measured on the server.
- **Number guess:** `1000 × (1 − |guess − answer| / tolerance)²`, minimum 0. Set the tolerance per question (error at which you get 0 points); if empty it defaults to 50% of the answer. Example, answer 2016, tolerance 10: guess 2014 → 640, 2011 → 250.
- Ties in total score are broken by the lower cumulative answer time.

All constants are at the top of `scoring.js`.

## Load test

With the server running: `npm run loadtest` plays a full 3-question game with 200 bots spread over the groups and checks the group counters, the group averages and the saved results.

## Storage

SQLite file `quiz.db` (quizzes, past games, results). Live game state is in memory only.

## Colors

Brand colors (navy `#141B2D`, green `#14A30B`, gray `#B8BCC2`) and the five group colors are defined at the top of `public/style.css` (`--bg`, `--accent`, `--gray`, `--g0` … `--g4`). Change them there.
