# csv-reader-speed-01

A faster reimplementation of csv-reader 1.0.0: `solve.js` answers every CSV
input exactly as csv-reader 1.0.0 does, using indexOf scans and single-slice
field extraction instead of the reference's character-at-a-time loop.
