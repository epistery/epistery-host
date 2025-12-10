# Epistery Host Test Suite

This directory contains the test suite for the Epistery Host project using Vitest.

## Test Files

### basic.test.js
Basic unit tests covering:
- Environment setup
- String operations and path generation
- Address normalization
- Policy validation
- Token validation

### AgentManager.test.js
Unit tests for the AgentManager module covering:
- Agent discovery from the `.agents` directory
- Manifest validation
- Agent loading and path routing
- Cleanup and error handling

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests in watch mode
```bash
npm run test:watch
```

### Run tests with UI
```bash
npm run test:ui
```

### Run tests with coverage
```bash
npm run test:coverage
```

## Test Configuration

Tests are configured via `vitest.config.js` in the project root:
- Environment: Node.js
- Test pattern: `tests/**/*.test.js`
- Coverage provider: c8
- Coverage output: text, json, and html formats

## Adding New Tests

1. Create a new file in the `tests/` directory with the `.test.js` extension
2. Import necessary testing utilities from vitest:
   ```javascript
   import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
   ```
3. Write your tests using the describe/it pattern
4. Run `npm test` to verify

## Mocking

For modules that require mocking (like fs, dns, or epistery), use vitest's mocking utilities:

```javascript
vi.mock('module-name', () => ({
  functionName: vi.fn()
}));
```
