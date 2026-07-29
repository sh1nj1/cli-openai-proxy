# Contributing to Claude Code CLI Provider

Thank you for your interest in contributing!

## Development Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Run: `node dist/server/standalone.js`

## Making Changes

1. Create a feature branch: `git checkout -b feature/your-feature`
2. Make your changes
3. Build and test: `npm run build`
4. Commit with a descriptive message
5. Push and create a PR

## Code Style

- TypeScript with strict mode
- Use `spawn()` instead of shell execution for security
- Add JSDoc comments to public functions
- Keep functions focused and small

## Testing

Build the project and run the automated tests:

```bash
npm run build
npm test
```

Measure coverage and enforce the same minimums used in CI (80% statements,
80% branches, 85% functions, and 80% lines):

```bash
npm run test:coverage
```

The command prints a text summary and writes `coverage/lcov.info`. CI uploads
the LCOV report as the `coverage-lcov` artifact.

Test the running server manually with:

```bash
# Start the server
node dist/server/standalone.js

# Test non-streaming
curl -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "paperclip/claude_local", "messages": [{"role": "user", "content": "Hi"}]}'

# Test streaming
curl -N -X POST http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "paperclip/claude_local", "messages": [{"role": "user", "content": "Hi"}], "stream": true}'
```

## Reporting Issues

Please include:
- Node.js version (`node --version`)
- Claude CLI version (`claude --version`)
- Operating system
- Steps to reproduce
- Error messages/logs

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
