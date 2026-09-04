# Complete technical workflow fixture

Real Remotion output and managed ffprobe validation, generated entirely offline.
The audio is a 60-second procedural sine tone **not speech**, not a human recording,
and not publishable narration. The short test script is deliberately repetitive.
The valid transactions exercise topic/script approval, voice commit, edit plan,
render, QC, journal recovery and path-form CLI status. No live API, no publishing.

`npm run dev -- status --project tests/fixtures/complete-project`

Build provenance: `tests/fixtures/build-complete-project.ts`. That explicit builder
refuses to overwrite an existing fixture. Temporary tone source files are kept
locally but excluded from Git; the immutable committed voice master is included.
