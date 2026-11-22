# Filter Observatory companion

WXT browser companion for the [Filter Observatory project](../README.md).
Canonical [design and limitations](../../../../../../docs/okf/filter-observatory/design.md)
and [module contracts](../../../../../../docs/okf/filter-observatory/module-contracts.md)
are maintained in the workspace documentation.

## Rebuild this source archive

Use Node.js 22.22.2+, 24.15+, or 26+ (the installed DOM test library requires
these supported release lines). From this directory:

```sh
npm ci
npm run build:firefox
```

`npm run build` produces the Chrome package contents. `npm run zip` and
`npm run zip:firefox` produce distribution archives in `.output/`; these commands
do not install or sign the extension. Worker connection settings are supplied at
runtime, so a build needs no credentials or environment file.

<footer class="hire-me">
  <h3>Hire me</h3>
  <p>Chirag Singhal — building free, open APIs and tools.</p>
  <p><a href="mailto:chirag@oriz.in">chirag@oriz.in</a> · <a href="https://github.com/chirag127">GitHub</a> · <a href="https://www.linkedin.com/in/chirag127/">LinkedIn</a> · <a href="https://x.com/singhal127">X</a> · <a href="https://www.youtube.com/@ChiragSinghal127">YouTube</a> · <a href="https://www.instagram.com/chiragsinghal127/">Instagram</a> · <a href="https://www.reddit.com/user/Far_Macaron_9910/">Reddit</a> · <a href="https://buymeacoffee.com/chirag127">Buy me a coffee</a></p>
</footer>
