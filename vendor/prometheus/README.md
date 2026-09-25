# Prometheus (vendored)

This directory contains the upstream **Prometheus** Lua obfuscator that powers the
LuaLune build pipeline. It is vendored (not a submodule) so the service can always
build scripts without a network fetch at deploy time.

| | |
| --- | --- |
| Upstream | https://github.com/prometheus-lua/Prometheus |
| Author | Elias Oelschner (levno-710) |
| Revision | `a4efc5f381c50ae2a111bdbb9272fa3203685be3` (`master`, 2026-07-27) |
| Included | `src/` (the Lua sources the engine runs) and `LICENSE` |

Attribution required by the license and shown in the LuaLune UI:

> Based on Prometheus by Elias Oelschner, https://github.com/prometheus-lua/Prometheus

Prometheus is licensed under the **Prometheus License** (see `LICENSE`), not MIT.
It permits commercial use, modification and hosting, but requires that attribution
to stay visible in the product (for a hosted service: the public web UI) and in
this README. Generated builds do not need to carry the notice.

## Updating

```bash
git clone --depth 1 https://github.com/prometheus-lua/Prometheus /tmp/prometheus
rm -rf vendor/prometheus/src
cp -r /tmp/prometheus/src vendor/prometheus/src
cp /tmp/prometheus/LICENSE vendor/prometheus/LICENSE
git -C /tmp/prometheus rev-parse HEAD   # record the new revision above
npm test                                # tests build and run real output
```

Only `src/` is vendored: `web/`, `tests/`, `doc/`, `scripts/` and the Node/web
tooling of upstream are not used by LuaLune.
