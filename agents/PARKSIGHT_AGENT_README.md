# ParkSight Agent

Finds camera-observed **street-parking spots in covered areas of San Francisco**, then warns you
about street cleaning and parking rules.

## What to ask

- *find me parking near the Castro Theatre*
- *parking at 18th and Castro*
- *I need a spot near Harvey Milk Plaza*

## What you get back

- The spot, hidden from other ParkSight users for **3 minutes** (the street space is not physically reserved)
- How recently its frame was processed, and the detection vote agreement
- The next **street-cleaning** window for that block (DataSF) and a relevant SFMTA rule excerpt when available
- A link to the latest camera frame and turn-by-turn directions

Coverage is limited to the blocks our cameras can see. Camera data can lag, so look before you pull in.
