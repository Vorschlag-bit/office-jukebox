# Project boundaries

- This is a personal, generic project. Keep account identifiers, tokens, pairing codes, actual device addresses and private deployment details out of commits and logs.
- Use repository files, local test processes and the GitHub connector for development. Desktop-wide inspection/control is outside this project's workflow.
- If signed-in Google setup is requested, use an explicitly connected browser tab and only the required site. Do not extract browser cookies, profile databases or credentials. If scoped browser access is unavailable, continue code work and report the specific setup step that remains.
- No automatic LAN scans, app inventory scans, port-forwarding, OS service installation, browser installation or security-setting changes. Diagnostics target only the configured device.
- Keep Python and third-party Node runtime dependencies optional. Baseline is Node 24 plus built-in modules.
- TV compatibility claims require identified physical hardware evidence. Simulation, CI, TCP reachability and HTTP command acceptance are not hardware playback verification.
- Never mark playback confirmed from a timer or a successful launch call. Preserve uncertainty and avoid automatic replay after a crash or ambiguous network failure.
- Run `node --test`. For network changes keep real loopback HTTP/TLS/WebSocket tests; use fake providers for external services. No live accounts, actual devices or real secrets in CI.
- Before publishing, verify only intended files are tracked, update the documented limits, push a coherent commit and check Windows/Linux CI results.
