# ParkSight Agent

Finds and holds an open **street-parking spot in San Francisco's Castro** using live public cameras, then warns you
about street cleaning and parking rules.

## What to ask

- *find me parking near the Castro Theatre*
- *parking at 18th and Castro*
- *I need a spot near Harvey Milk Plaza*

## What you get back

- The spot, held for you for **3 minutes** so no other driver is sent there
- How many seconds ago a camera saw it open, and a confidence score
- The next **street-cleaning** window for that block (DataSF) and a relevant SFMTA rule excerpt when available
- A link to the latest camera frame and turn-by-turn directions

Coverage is limited to the blocks our cameras can see. Camera data can lag, so look before you pull in.
