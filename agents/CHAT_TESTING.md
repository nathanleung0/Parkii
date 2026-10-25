# Connection-only chat testing

After connecting the mailbox, open the agent profile and choose **Chat with Agent** to enter ASI:One.
Send **help** first. The agent acknowledges and replies with its capabilities without geocoding,
calling Convex, querying rules, or creating a parking hold. Greetings and **test connection** also
use this local reply. A leading @mention of this agent is removed before routing.
Normal ASI:One account or plan limits still apply.

For strict connection-only testing, set `PARKII_CHAT_ONLY=1` in ignored `agents/.env` before
starting the agent. This also blocks geocoding, Convex and rules calls for parking messages, with an
explicit paused-search reply. Set it back to `0` and restart only when ready to test parking.
The default in `.env.example` is `0`, preserving normal parking behavior.

For a real parking test without an LLM, use [nearest-spot mode](NEAREST_MODE.md), then try
**find me parking near the Castro Theatre** and verify the spot, freshness, rules, camera links and
directions. The alternative Claude-backed mode still needs confirmation of the team's API credits. A help response proves
chat delivery only; it does not prove the complete parking workflow or sponsor eligibility.
