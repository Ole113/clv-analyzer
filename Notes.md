## Generating a new API key

openssl rand -hex 24 # generate

Then edit server/.env, set API_KEY=<the new value>, restart the server, and paste the same value into the extension options on every browser (they each store their own copy). Mismatches surface as server 401.

To read the current one:

grep '^API_KEY=' server/.env
