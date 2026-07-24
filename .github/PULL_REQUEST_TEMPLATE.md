# What & why

<!-- What does this change do, and why? Link the issue if one exists. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`, see [DCO](../DCO))
- [ ] `npm run lint:boundaries` passes (extensions import only from `@api`)
- [ ] `npx tsc --noEmit` passes; relevant `vitest` / `cargo test` suites pass
- [ ] For persistence-touching changes: save → reload round-trip verified
- [ ] For new/changed extension API: `docs/EXTENSION_GUIDE.md` updated
