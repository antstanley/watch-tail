---
'watch-tail': patch
---

Shrink the npm package from 7.0 MB to 1.7 MB unpacked (1.9 MB to 0.5 MB packed), and the install
from about 90 MB to 22 MB. The chart library is no longer compiled into the server build, source
maps and pre-compressed `.gz`/`.br` copies no longer ship, and `layerchart` and `@lucide/svelte`
are no longer installed as dependencies, since the build already bundles them. A new
`pnpm check:package` step keeps the package within a size budget in CI.
