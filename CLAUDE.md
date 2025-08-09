# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a TypeScript library for model validation that provides a fluent API for creating validators with business rules and dependency injection. It's built on top of the StandardSchema specification and currently supports Zod schemas.

## Key Commands

### Development
- `pnpm build` - Build TypeScript to dist/
- `pnpm test` - Run tests with Vitest
- `pnpm lint` - Type-check without emitting (tsc --noEmit)

### Testing
- `pnpm test` - Run all tests
- `pnpm test src/test.spec.ts` - Run specific test file
- Tests use Vitest framework located in src/*.spec.ts files

### Publishing
- `pnpm publish` - Publish to npm (runs prepublishOnly hook which builds first)

## Architecture

### Core Components

1. **FluentValidatorBuilder** (src/index.ts:212-491)
   - Main builder class providing fluent API
   - Manages schema, dependencies, context rules, and execution
   - Type-safe dependency injection with compile-time checks
   - Supports command pattern with validation

2. **ErrorBag** (src/index.ts:18-95)
   - Collects and manages validation errors
   - Provides multiple output formats (object, flatten, HTML, text)
   - Supports field-specific and global errors

3. **StandardSchemaV1** (src/standard-schema.ts)
   - Interface for schema validation libraries
   - Currently implemented with Zod

### Key Patterns

1. **Fluent Builder Pattern**
   ```typescript
   buildValidator()
     .input(schema)
     .$deps<DepsType>()
     .rule(rule)
     .provide(deps)
     .command({ execute })
   ```

2. **Dependency Injection Flow**
   - `$deps<T>()` - Declare required dependencies
   - `provide(deps)` - Supply dependencies before execution
   - Type system enforces deps are provided before validation/execution

3. **Context Passing**
   - Rules can return context objects that get merged
   - Subsequent rules receive accumulated context
   - Enables multi-step validation with data sharing

### Type Safety Features

- Compile-time enforcement of dependency provision
- Schema input/output type inference
- Context type accumulation through rule chain
- Command result types based on schema and execution

## Important Implementation Details

- All async operations properly handled with Promise support
- Debug console.dir at src/index.ts:429 should be removed before production
- Validation runs schema validation first, then custom rules
- Rules can add errors to ErrorBag and/or return context
- Commands can return either execution result or ErrorBag for business logic errors