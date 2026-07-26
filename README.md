# Name of Thrones

Name of Thrones is an unofficial, noncommercial fan quiz. Version 1 contains
exactly 1,000 named characters. Enter names to reveal character cards, track
progress, and filter the results by house or group.

## Gameplay

A guess must match a full character name or a listed alias. Matching is exact
after normalizing case, outside and repeated spaces, common accent marks,
apostrophes, hyphens, and punctuation. Partial names and fuzzy guesses do not
match. If one accepted alias belongs to more than one record, all matching
records are revealed.

Progress is kept in the browser's local storage. Resetting the game clears that
saved progress.

## Version 1 data and limits

The checked release contains 1,000 named records with at least one book
reference. It excludes blank or clearly unnamed records and known TV-only,
game-only, semi-canon, and *The Ice Dragon* markers.

The preferred importer source is [A Wiki of Ice and Fire][awoiaf]. During
creation of the checked release, A Wiki of Ice and Fire returned HTTP 403, so
this release uses [An API of Ice and Fire][api] instead. This fallback does not
prove complete coverage of *Fire & Blood*. The API does not state a separate
data license, so its factual data must not be treated as MIT-licensed project
code.

The future goal is to cover every named, book-canon character that can be
reliably sourced across the published novels, the Dunk and Egg stories,
*Fire & Blood*, and other published companion histories. That work also
includes better source and revision tracking, complete aliases, houses and
factions, accessibility, progress tools, and carefully reviewed original
portraits. TV-only and game-only characters remain outside that scope.

## Run locally

The site has no build step. From the repository root, run:

```sh
python3 -m http.server
```

Then open <http://localhost:8000/>. Do not open `index.html` directly because
the browser must fetch the JSON data over HTTP.

## Checks

The checks use only Python and Node.js built-in tools:

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/validate_data.py
npm test
```

No OpenAI or Pillow package is needed for tests, data validation, or a portrait
dry run.

## Portrait pipeline

The checked project does not claim that generated portraits exist. House
placeholders are used unless a future portrait is generated and approved.

Preview a small batch without an API key, network request, OpenAI package, or
Pillow package:

```sh
python3 scripts/generate_portraits.py --limit 5
```

Generation costs money and needs a separate local environment with the OpenAI
SDK and Pillow:

```sh
python3 -m venv .venv
. .venv/bin/activate
python3 -m pip install openai Pillow
test -n "${OPENAI_API_KEY:-}"
python3 scripts/generate_portraits.py \
  --execute \
  --limit 5 \
  --confirm "GENERATE PORTRAITS"
unset OPENAI_API_KEY
```

Set `OPENAI_API_KEY` in the process environment with a trusted secret manager
before running these commands. Never put the key in a command argument,
repository file, screenshot, issue, chat, or commit. Never print it.

Generation never approves an image. Review each generated file for quality,
safety, unwanted text, copyrighted designs, and resemblance to a real actor.
Then approve or reject it by its character ID:

```sh
python3 scripts/generate_portraits.py --approve character-api-339
python3 scripts/generate_portraits.py --reject character-api-339
```

Approval checks that the file is a safe 512 by 512 WebP image, records the
review in the manifest, and publishes its path in `data/characters.json`.
Rejection clears the published path but keeps the image for later review.

AI-generated portraits, if added later, are artistic interpretations. They may
be inaccurate or biased, are not canonical, and are not official art. They
must not copy wiki images, official art, franchise designs, or actor
likenesses.

## Attribution and rights

See [ATTRIBUTION.md](ATTRIBUTION.md),
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and
[LICENSE-CODE.md](LICENSE-CODE.md). The MIT license covers only original
project code. It does not cover datasets, source material, franchise rights,
or generated assets.

This project is not affiliated with or endorsed by George R. R. Martin, HBO,
or their publishers, licensees, or rights holders. Names and story material
remain the property of their respective owners. No wiki images are reused.

## Deployment

GitHub Pages deployment runs on pushes to `main` and by manual dispatch. The
workflow runs Python tests, data validation, a safe portrait dry run, and the
Node.js test before uploading the unchanged static site. The deploy job runs
only if all checks pass.

In the GitHub repository settings, set Pages to use **GitHub Actions**. Push to
`main`, or open the Actions tab and run the Pages workflow manually. The
workflow uses read-only repository access plus the Pages and identity-token
permissions needed by the official Pages deploy action.

## Sources

- [A Wiki of Ice and Fire][awoiaf]
- [A Wiki of Ice and Fire copyright notice][awoiaf-copyright]
- [Creative Commons Attribution-ShareAlike 3.0][cc-by-sa]
- [An API of Ice and Fire documentation][api]
- [GitHub Pages custom workflows][pages-docs]

[awoiaf]: https://awoiaf.westeros.org/
[awoiaf-copyright]: https://awoiaf.westeros.org/index.php/A_Wiki_of_Ice_and_Fire:Copyrights
[cc-by-sa]: https://creativecommons.org/licenses/by-sa/3.0/
[api]: https://anapioficeandfire.com/Documentation
[pages-docs]: https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
