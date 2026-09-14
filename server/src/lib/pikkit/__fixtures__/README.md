`transactions-sample.csv` is a Pikkit export trimmed to twenty rows, chosen to cover all seven
sportsbooks and every leg format the parser has to read.

The **leg text is real**, because that is the whole point of the fixture: the seven books each
write a leg differently and the parser has to cut player, market and matchup out of a run-on
string with no delimiters. Everything else is synthetic — bet ids, stakes, profits and timestamps
were replaced, since this repository is public and a real export is a personal betting record.
Profits are recomputed from the stake and the odds, so the row is still internally consistent and
the money-side assertions still mean something.
